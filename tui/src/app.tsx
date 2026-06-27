import React, { useEffect, useMemo, useState } from 'react';
import { useRenderer } from '@opentui/react';
import { TextAttributes, getTreeSitterClient, SyntaxStyle, RGBA } from '@opentui/core';
import { useManageInput } from './hooks/use-manage-input.js';
import { useDetectionCache, type DetectionCache } from './hooks/use-detection-cache.js';
import {
	createInitialManageState,
	menuItems,
	reduceManageState,
	UPDATE_BUTTON,
	type ManageModuleId,
	type ManageState
} from './state/manage-state.js';
import { navShortcuts, viewShortcuts } from './state/shortcuts.js';
import { ShortcutBar, ToastViewport, UpdateModal, type StatusDotKind, type UpdateModalStatus } from './components/index.js';
import { colors, borderColors, borderStyles, PRIMARY } from './theme/index.js';
import { CCQ_LOGO, CCQ_LOGO_COLORS } from './theme/logo.js';
import { displayWidth } from './core/text-utils.js';
// 导入 6 个视图组件
import { ProviderView } from './views/provider-view.js';
import McpView from './views/mcp/McpView.js';
import { SkillsView } from './views/SkillsView.js';
import { PromptsView } from './views/PromptsView.js';
import { ConfigView } from './views/ConfigView.js';
import { ToolsView } from './views/ToolsView.js';

// 导入视图 services
import { createSkillsViewServices } from './views/skills-view-services.js';
import { createToolsViewServices } from './views/tools-view-services.js';

// logo 每行 13 列宽（块面风格），侧边栏内宽 = SIDEBAR_WIDTH - 2(边框) - 2(paddingX) = 20，菜单标签充裕。
const SIDEBAR_WIDTH = 24;

export default function App() {
	const [state, setState] = useState(createInitialManageState);
	const [viewSubMode, setViewSubMode] = useState<string>('');
	const [updateModalOpen, setUpdateModalOpen] = useState(false);
	const [updateStatus, setUpdateStatus] = useState<UpdateModalStatus>('checking');
	// 右侧内容区当前显示的菜单 id：selectedIndex 在菜单范围内时跟随，停在底部按钮位时保持上一个（按钮不切视图，回车只开浮窗）
	const [displayMenuId, setDisplayMenuId] = useState<ManageModuleId>(menuItems[0]!.id);
	const renderer = useRenderer();
	useEffect(() => {
		if (state.selectedIndex < menuItems.length) {
			setDisplayMenuId(menuItems[state.selectedIndex]!.id);
		}
	}, [state.selectedIndex]);

	// 初始化 Tree-sitter 语法高亮（Phase 5B.1）
	const [syntaxStyle, setSyntaxStyle] = useState<SyntaxStyle | null>(null);
	useEffect(() => {
		let mounted = true;
		(async () => {
			const client = getTreeSitterClient();
			await client.initialize();
			if (!mounted) return;

			// GitHub Dark 主题配色
			const style = SyntaxStyle.fromStyles({
				keyword: { fg: RGBA.fromHex('#FF7B72'), bold: true },
				string: { fg: RGBA.fromHex('#A5D6FF') },
				number: { fg: RGBA.fromHex('#79C0FF') },
				comment: { fg: RGBA.fromHex('#8B949E'), italic: true },
				function: { fg: RGBA.fromHex('#D2A8FF') },
				type: { fg: RGBA.fromHex('#FFA657') },
				operator: { fg: RGBA.fromHex('#FF7B72') },
				default: { fg: RGBA.fromHex('#E6EDF3') }
			});
			setSyntaxStyle(style);
		})();
		return () => {
			mounted = false;
		};
	}, []);

	// Skills 视图：services + cache（检测已安装 skills）
	const skillsViewServices = useMemo(() => createSkillsViewServices(), []);
	const skillsCache = useDetectionCache(skillsViewServices);

	// Tools 视图：services + cache（检测已安装工具）
	const toolsViewServices = useMemo(() => createToolsViewServices(), []);
	const toolsCache = useDetectionCache(toolsViewServices);

	// 获取终端尺寸（OpenTUI 通过 renderer 获取）
	const terminalWidth = renderer?.width ?? 80;
	const terminalHeight = renderer?.height ?? 24;
	// 右侧内容区可用宽度 = 总宽 - 左侧栏(SIDEBAR_WIDTH) - 右栏边框(2) - paddingX(2)，驱动工具管理网格列数。
	const contentWidth = Math.max(0, terminalWidth - SIDEBAR_WIDTH - 4);

	useEffect(() => {
		if (state.shouldExit) {
			renderer?.destroy();
		}
	}, [renderer, state.shouldExit]);

	// 全局键盘分发：nav 焦点始终激活；进入 view 后，凡是自带键盘处理的视图
	// 都让位给视图自身处理，避免双重响应；浮窗打开时也让位给浮窗自身处理。
	// 其余模块由全局 reducer 处理 Esc/← 返回导航。
	const viewModulesWithInput = useMemo(() => new Set(menuItems.map(item => item.id)), []);
	const ownsViewInput = updateModalOpen || (state.focus === 'view' && viewModulesWithInput.has(displayMenuId));
	useManageInput(keyName => {
		// 底部「检查更新」按钮：nav 焦点 + 按钮位 + 确认键 → 打开浮窗（不进 view）
		if (
			state.focus === 'nav' &&
			state.selectedIndex === menuItems.length &&
			(keyName === 'enter' || keyName === 'right' || keyName === 'tab') &&
			!updateModalOpen
		) {
			setUpdateModalOpen(true);
			return;
		}
		setState(current => reduceManageState(current, keyName));
	}, !ownsViewInput);

	const navActive = state.focus === 'nav';

	// 内容区可视高度：总高 - 外层无边框 - 两个 card 边框/padding - footer 行 - 分隔线
	const sidebarInnerWidth = SIDEBAR_WIDTH - 4;
	const contentViewportHeight = Math.max(4, terminalHeight - 6);

	// 双卡片双层布局：
	// 左卡片 = Logo（纯色） + 下划线分隔 + menu
	// 右卡片 = content（flexGrow，焦点驱动滚动） + 下划线分隔 + footer
	return (
		<>
			<ToastViewport position="bottom-right" stackingMode="stack" visibleToasts={3} />
			<box flexDirection="row" width={terminalWidth} height={terminalHeight}>
				{/* 左侧导航栏 */}
				<box
					flexDirection="column"
					width={SIDEBAR_WIDTH}
					flexShrink={0}
					borderStyle={navActive ? borderStyles.active : borderStyles.inactive}
					borderColor={navActive ? borderColors.active : borderColors.inactive}
					paddingX={1}
				>
					{/* Logo 区域：逐行垂直渐变（橙色系，亮→深），制造炫彩光泽；alignItems 居中 */}
					<box flexDirection="column" alignItems="center">
						{CCQ_LOGO.map((line, i) => (
							<text key={i} fg={CCQ_LOGO_COLORS[i] ?? PRIMARY} attributes={TextAttributes.BOLD}>
								{line}
							</text>
						))}
					</box>

					<Divider width={sidebarInnerWidth} />

					{/* 菜单列表：active 项用 ▸ 指示器 + 背景高亮条（铺满菜单宽度）+ 粗体三重状态；行间 marginBottom 1 增高行距不显拥挤 */}
					<box flexDirection="column">
						{menuItems.map((item, index) => (
							<NavRow
								key={item.id}
								label={item.label}
								selected={index === state.selectedIndex}
								navActive={navActive}
								width={sidebarInnerWidth}
							/>
						))}
					</box>

					{/* 弹性空白：把底部「检查更新」按钮推到侧边栏底部 */}
					<box flexGrow={1} />

					<Divider width={sidebarInnerWidth} />

					{/* 底部固定的「检查更新」按钮（占第 menuItems.length 个导航位，下键可达） */}
					<NavRow
						label={UPDATE_BUTTON.label}
						selected={state.selectedIndex === menuItems.length}
						navActive={navActive}
						width={sidebarInnerWidth}
						statusKind={updateStatusKind(updateStatus, updateModalOpen)}
					/>
				</box>

				{/* 右侧内容区 */}
				<box
					flexDirection="column"
					flexGrow={1}
					borderStyle={!navActive ? borderStyles.active : borderStyles.inactive}
					borderColor={!navActive ? borderColors.active : borderColors.inactive}
					paddingX={1}
				>
					{/* 内容视图区域 */}
					<box flexDirection="column" flexGrow={1} height={contentViewportHeight} overflow="hidden">
						<ModuleContent
							moduleId={displayMenuId}
							viewportHeight={contentViewportHeight}
							contentWidth={contentWidth}
							active={state.focus === 'view'}
							skillsViewServices={skillsViewServices}
							skillsCache={skillsCache}
							toolsViewServices={toolsViewServices}
							toolsCache={toolsCache}
							onSubModeChange={setViewSubMode}
							syntaxStyle={syntaxStyle}
							onExitToNav={() => {
								setViewSubMode('');
								setState(current => reduceManageState(current, 'escape'));
							}}
						/>
					</box>

					<Divider width={terminalWidth - SIDEBAR_WIDTH - 4} />

					{/* Footer 快捷键提示 */}
					<ShortcutBar shortcuts={navActive ? navShortcuts() : viewShortcuts(displayMenuId, viewSubMode)} />
				</box>
			</box>

			{/* 检查更新浮窗：底部按钮回车触发，position=absolute 居中覆盖主界面（非独立页面） */}
			<UpdateModal
				active={updateModalOpen}
				onClose={() => setUpdateModalOpen(false)}
				onStatusChange={setUpdateStatus}
				viewportWidth={terminalWidth}
				viewportHeight={terminalHeight}
			/>
		</>
	);
}

// 卡片内分区下划线（替代独立 card 边框，Logo/menu 与 content/footer 各自一卡内分隔）
function Divider({ width }: { readonly width: number }) {
	return <text fg={colors.muted}>{'─'.repeat(Math.max(1, width))}</text>;
}

// 侧边栏导航行（菜单项与底部「检查更新」按钮共用渲染）：
// ▸ 指示器 + 背景高亮条（铺满宽度）+ 粗体三重状态。抽组件避免菜单项与按钮渲染重复（DRY）。
// marginBottom 拉开行距，避免菜单视觉拥挤。
function NavRow({ label, selected, navActive, width, statusKind }: {
	readonly label: string;
	readonly selected: boolean;
	readonly navActive: boolean;
	readonly width: number;
	readonly statusKind?: StatusDotKind;
}) {
	const indicator = selected ? '▸ ' : '  ';
	const statusText = statusKind ? '● ' : '';
	const raw = `${indicator}${statusText}${label}`;
	const text = raw + ' '.repeat(Math.max(0, width - displayWidth(raw)));
	const fg = selected ? (navActive ? '#1A1A1A' : colors.primary) : colors.muted;
	const bg = selected ? (navActive ? PRIMARY : '#3A2A20') : undefined;
	return (
		<box marginBottom={1}>
			<box flexDirection="row" width={width} backgroundColor={bg}>
				<text
					fg={fg}
					bg={bg}
					attributes={selected ? TextAttributes.BOLD : 0}
				>
					{indicator}
				</text>
				{statusKind ? <text fg={statusDotColor(statusKind)} bg={bg}>● </text> : null}
				<text
					fg={fg}
					bg={bg}
					attributes={selected ? TextAttributes.BOLD : 0}
				>
					{statusKind ? ` ${label}${' '.repeat(Math.max(0, width - displayWidth(raw)))}` : `${label}${' '.repeat(Math.max(0, width - displayWidth(raw)))}`}
				</text>
			</box>
		</box>
	);
}

function updateStatusKind(status: UpdateModalStatus, active: boolean): StatusDotKind {
	if (!active) {
		return 'unknown';
	}

	switch (status) {
		case 'checking':
		case 'downloading':
		case 'applying':
			return 'updating';
		case 'available':
			return 'updatable';
		case 'latest':
		case 'confirm-restart':
		case 'updated':
			return 'latest';
		case 'error':
			return 'failed';
	}
}

function statusDotColor(kind: StatusDotKind): string {
	switch (kind) {
		case 'updatable':
			return colors.warning;
		case 'latest':
			return colors.success;
		case 'failed':
			return colors.danger;
		case 'updating':
		case 'installing':
		case 'uninstalling':
			return colors.primary;
		case 'unknown':
		case 'notInstalled':
			return colors.muted;
	}
}

// 右侧内容区路由：六个模块视图
function ModuleContent({
	moduleId,
	viewportHeight,
	contentWidth,
	active,
	skillsViewServices,
	skillsCache,
	toolsViewServices,
	toolsCache,
	onSubModeChange,
	onExitToNav,
	syntaxStyle
}: {
	readonly moduleId: string;
	readonly viewportHeight: number;
	readonly contentWidth: number;
	readonly active: boolean;
	readonly skillsViewServices: ReturnType<typeof createSkillsViewServices>;
	readonly skillsCache: DetectionCache<any>;
	readonly toolsViewServices: ReturnType<typeof createToolsViewServices>;
	readonly toolsCache: DetectionCache<any>;
	readonly onSubModeChange: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly syntaxStyle: SyntaxStyle | null;
}) {
	// 根据 moduleId 渲染对应的视图组件
	switch (moduleId) {
		case 'provider':
			return <ProviderView active={active} viewportHeight={viewportHeight} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		case 'mcp':
			return <McpView active={active} viewportHeight={viewportHeight} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		case 'skills':
			return <SkillsView services={skillsViewServices} cache={skillsCache} active={active} viewportHeight={viewportHeight} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		case 'prompts':
			return <PromptsView active={active} viewportHeight={viewportHeight} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} syntaxStyle={syntaxStyle} />;
		case 'config':
			return <ConfigView active={active} viewportHeight={viewportHeight} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} syntaxStyle={syntaxStyle} />;
		case 'tools':
			return <ToolsView services={toolsViewServices} cache={toolsCache} active={active} viewportHeight={viewportHeight} contentWidth={contentWidth} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		default:
			// 兜底：显示模块信息
			const item = menuItems.find(menuItem => menuItem.id === moduleId);
			return (
				<box flexDirection="column">
					<text fg={PRIMARY} attributes={TextAttributes.BOLD}>
						{item?.label ?? moduleId}
					</text>
					<box marginTop={1}>
						<text fg={colors.muted} attributes={TextAttributes.DIM}>
							{item?.description ?? ''}
						</text>
					</box>
					<box marginTop={1}>
						<text fg={colors.warning}>
							⚠ 未知模块
						</text>
					</box>
				</box>
			);
	}
}
