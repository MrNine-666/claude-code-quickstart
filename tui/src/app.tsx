import {existsSync} from 'node:fs';
import React, {useEffect, useMemo, useRef, useState} from 'react';
import {useRenderer} from '@opentui/react';
import {TextAttributes, getTreeSitterClient, SyntaxStyle, RGBA, type ThemeMode as OpenTuiThemeMode} from '@opentui/core';
import {useManageInput} from './hooks/use-manage-input.js';
import {useDetectionCache, type DetectionCache} from './hooks/use-detection-cache.js';
import {
	createInitialManageState,
	menuItems,
	reduceManageState,
	AGENT_CONTEXT_LABELS,
	AGENT_CONTEXT_ORDER,
	UPDATE_BUTTON,
	type AgentContext,
	type ManageModuleId,
	type ManageState
} from './state/manage-state.js';
import {navShortcuts, viewShortcuts, updateButtonShortcuts, headerShortcuts} from './state/shortcuts.js';
import {
	Modal,
	ShortcutBar,
	Spinner,
	ToastViewport,
	toast,
	type BusyOverlayState,
	type Shortcut,
	type StatusDotKind
} from './components/index.js';
import {
	colors,
	borderColors,
	borderStyles,
	activeBorderChars,
	PRIMARY,
	getTheme,
	setActiveTheme,
	type AppThemeMode,
	type ThemePalette
} from './theme/index.js';
import {CCQ_LOGO} from './theme/logo.js';
import {CCQ_VERSION} from './version.js';
import {
	applyUpdate,
	checkLatestVersion,
	cleanupTempUpdate,
	downloadUpdate,
	formatSelfUpdateError,
	restartExecutable,
	type DownloadedSelfUpdate,
	type DownloadUpdateProgress,
	type SelfUpdatePlan
} from './core/update.js';
import {
	isSelfUpdateCancellable,
	reduceSelfUpdateScreen,
	selfUpdateScreenVersion,
	type SelfUpdateScreen
} from './state/self-update-state.js';
// 导入 6 个视图组件
import {ProviderView} from './views/provider-view.js';
import McpView from './views/mcp/McpView.js';
import {SkillsView} from './views/SkillsView.js';
import {PromptsView} from './views/PromptsView.js';
import {ConfigView} from './views/ConfigView.js';
import {ToolsView} from './views/ToolsView.js';

// 导入视图 services
import {createSkillsViewServices} from './views/skills-view-services.js';
import {createToolsViewServices} from './views/tools-view-services.js';

// logo 每行 13 列宽（块面风格），侧边栏内宽 = SIDEBAR_WIDTH - 2(边框) - 2(paddingX) = 20，菜单标签充裕。
const SIDEBAR_WIDTH = 24;

// 隐藏 Agent Header 的模块（shared-resource-injection-ui D3/M3）：Tools 与 MCP 用共享双侧列表，
// 不按 Header 单一 agentContext 过滤，故进入这两个模块隐藏 Header；其余模块 Header 常显。
const AGENT_HEADER_HIDDEN_MODULES = new Set<ManageModuleId>(['tools', 'mcp', 'skills']);

// 是否运行在 Bun --compile 单文件可执行产物中。
// 源码模式下 import.meta.dirname 是真实磁盘目录（existsSync=true）；
// 编译产物下它是 Bun 虚拟路径（如 B:\~BUN\root），existsSync=false。
// Tree-sitter worker 在编译产物中无法被正确嵌入/解析（Bun compile 不会嵌入
// new Worker(new URL(...)) 动态引用的 worker 文件，且 existsSync 失效导致
// OpenTUI 回退到不存在的 parser.worker.ts），故编译产物下禁用语法高亮、降级纯文本。
const IS_COMPILED_EXECUTABLE = import.meta.dirname != null && !existsSync(import.meta.dirname);

type UpdateStatus = SelfUpdateScreen['kind'];

type AppProps = {
	readonly initialThemeMode: AppThemeMode;
	readonly onExit: () => void;
};

function normalizeThemeMode(mode: OpenTuiThemeMode | null | undefined): AppThemeMode {
	return mode === 'light' ? 'light' : 'dark';
}

function createSyntaxStyle(theme: ThemePalette): SyntaxStyle {
	const {syntax} = theme;
	return SyntaxStyle.fromStyles({
		// code token（fenced code block：TS/JS）
		keyword: {fg: RGBA.fromHex(syntax.keyword), bold: true},
		string: {fg: RGBA.fromHex(syntax.string)},
		number: {fg: RGBA.fromHex(syntax.number)},
		comment: {fg: RGBA.fromHex(syntax.comment), italic: true},
		function: {fg: RGBA.fromHex(syntax.function)},
		type: {fg: RGBA.fromHex(syntax.type)},
		operator: {fg: RGBA.fromHex(syntax.operator)},
		// markdown markup token（全局规则页 CLAUDE.md：标题/粗体/列表/引用/代码/链接着色）
		'markup.heading': {fg: RGBA.fromHex(syntax.markupHeading), bold: true},
		'markup.heading.1': {fg: RGBA.fromHex(syntax.markupHeading1), bold: true},
		'markup.heading.2': {fg: RGBA.fromHex(syntax.markupHeading2), bold: true},
		'markup.heading.3': {fg: RGBA.fromHex(syntax.markupHeading3), bold: true},
		'markup.bold': {fg: RGBA.fromHex(syntax.markupBold), bold: true},
		'markup.strong': {fg: RGBA.fromHex(syntax.markupBold), bold: true},
		'markup.italic': {fg: RGBA.fromHex(syntax.markupBold), italic: true},
		'markup.list': {fg: RGBA.fromHex(syntax.markupList)},
		'markup.list.checked': {fg: RGBA.fromHex(syntax.markupListChecked)},
		'markup.quote': {fg: RGBA.fromHex(syntax.markupQuote), italic: true},
		'markup.raw': {fg: RGBA.fromHex(syntax.markupRaw)},
		'markup.raw.block': {fg: RGBA.fromHex(syntax.markupRaw)},
		'markup.link': {fg: RGBA.fromHex(syntax.markupLink), underline: true},
		'markup.link.url': {fg: RGBA.fromHex(syntax.markupLink), underline: true},
		default: {fg: RGBA.fromHex(syntax.default)}
	});
}

export default function App({initialThemeMode, onExit}: AppProps) {
	const [themeMode, setThemeMode] = useState<AppThemeMode>(initialThemeMode);
	const theme = useMemo(() => getTheme(themeMode), [themeMode]);
	const [state, setState] = useState(createInitialManageState);
	const [viewSubMode, setViewSubMode] = useState<string>('');
	const [busyOverlay, setBusyOverlay] = useState<BusyOverlayState | null>(null);
	const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
	const [updateScreen, setUpdateScreen] = useState<SelfUpdateScreen>({kind: 'checking'});
	const updateAbortRef = useRef<AbortController | null>(null);
	// 右侧内容区当前显示的菜单 id：selectedIndex 在菜单范围内时跟随，停在底部按钮位时保持上一个（按钮不切视图，回车只开浮窗）
	const [displayMenuId, setDisplayMenuId] = useState<ManageModuleId>(menuItems[0]!.id);
	const renderer = useRenderer();
	useEffect(() => {
		const handleThemeMode = (nextMode: OpenTuiThemeMode): void => {
			const normalized = normalizeThemeMode(nextMode);
			setActiveTheme(normalized);
			setThemeMode(normalized);
		};

		renderer.on('theme_mode', handleThemeMode);
		return () => {
			renderer.off('theme_mode', handleThemeMode);
		};
	}, [renderer]);

	useEffect(() => {
		if (state.selectedIndex < menuItems.length) {
			setDisplayMenuId(menuItems[state.selectedIndex]!.id);
		}
	}, [state.selectedIndex]);

	// Tools / MCP 模块不渲染 Header：残留 header 焦点强制回 view。
	useEffect(() => {
		if (AGENT_HEADER_HIDDEN_MODULES.has(displayMenuId) && state.focus === 'header') {
			setState(current => ({...current, focus: 'view'}));
		}
	}, [displayMenuId, state.focus]);

	// 初始化 Tree-sitter 语法高亮（Phase 5B.1），配色随终端 dark/light 主题重建。
	const [syntaxStyle, setSyntaxStyle] = useState<SyntaxStyle | null>(null);
	useEffect(() => {
		// 编译产物中 Tree-sitter worker 无法启动（见 IS_COMPILED_EXECUTABLE 注释），
		// 直接跳过：getTreeSitterClient() 构造即 startWorker 会触发 worker error 日志，
		// 故连 client 都不创建；syntaxStyle 保持 null，视图自动降级为纯文本。
		if (IS_COMPILED_EXECUTABLE) {
			return;
		}
		let mounted = true;
		(async () => {
			const client = getTreeSitterClient();
			await client.initialize();
			if (!mounted) return;

			setSyntaxStyle(createSyntaxStyle(theme));
		})();
		return () => {
			mounted = false;
		};
	}, [theme]);

	// Skills 视图：services + cache（检测已安装 skills）。共享本体+双侧投影后检测与 agentContext 无关
	// （一次 skills list -g --json 无 --agent 得双侧态），故 services 不随 Header 重建、cache 不重跑。
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
			onExit();
		}
	}, [onExit, state.shouldExit]);

	const runUpdateCheck = async (): Promise<void> => {
		setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'checkStarted'}));
		const info = await checkLatestVersion();
		if (!info.ok) {
			setUpdateScreen(current =>
				reduceSelfUpdateScreen(current, {
					type: 'failed',
					message: formatSelfUpdateError(info.error)
				})
			);
			return;
		}

		setUpdateScreen(current =>
			reduceSelfUpdateScreen(current, info.hasUpdate ? {type: 'updateAvailable', plan: info.plan} : {type: 'latestConfirmed'})
		);
	};

	const restartUpdatedApp = async (): Promise<void> => {
		renderer?.destroy();
		const restarted = await restartExecutable();
		if (!restarted.ok) {
			const message = formatSelfUpdateError(restarted.error);
			console.error(message);
			process.exit(1);
		}

		process.exit(0);
	};

	const cancelUpdate = (): void => {
		const controller = updateAbortRef.current;
		if (!controller) {
			return;
		}

		setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'cancelRequested'}));
		controller.abort();
	};

	const runUpdate = async (plan: SelfUpdatePlan): Promise<void> => {
		const abortController = new AbortController();
		updateAbortRef.current = abortController;
		setUpdateDialogOpen(true);
		setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'downloadStarted', plan}));

		const downloaded = await downloadUpdate(plan, abortController.signal, {
			onProgress: progress => {
				setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'downloadProgress', progress}));
			}
		});
		updateAbortRef.current = null;
		if (abortController.signal.aborted) {
			if (downloaded.ok) await cleanupTempUpdate(downloaded.transaction);
			setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'updateAvailable', plan}));
			return;
		}

		if (!downloaded.ok) {
			const message = formatSelfUpdateError(downloaded.error);
			toast.error(message);
			setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'failed', message}));
			return;
		}

		setUpdateScreen(current =>
			reduceSelfUpdateScreen(current, {
				type: 'downloadReady',
				transaction: downloaded.transaction
			})
		);
	};

	const applyDownloadedUpdate = async (transaction: DownloadedSelfUpdate): Promise<void> => {
		setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'applyStarted', transaction}));
		const applied = await applyUpdate(transaction, {restartAfterApply: true});
		if (!applied.ok) {
			const message = formatSelfUpdateError(applied.error);
			toast.error(message);
			setUpdateScreen(current => reduceSelfUpdateScreen(current, {type: 'failed', message}));
			return;
		}

		if (applied.state === 'scheduled') {
			renderer?.destroy();
			process.exit(0);
		}

		setUpdateScreen(current =>
			reduceSelfUpdateScreen(current, {
				type: 'applyCompleted',
				version: transaction.plan.version
			})
		);
	};

	useEffect(() => {
		// 启动时自动检查更新
		void runUpdateCheck();
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, []);

	// 全局键盘分发：nav 焦点始终激活；进入 view 后，凡是自带键盘处理的视图
	// 都让位给视图自身处理，避免双重响应；浮窗打开时也让位给浮窗自身处理。
	// 其余模块由全局 reducer 处理 Esc/← 返回导航。
	const viewModulesWithInput = useMemo(() => new Set(menuItems.map(item => item.id)), []);
	const ownsViewInput = busyOverlay !== null || updateDialogOpen || (state.focus === 'view' && viewModulesWithInput.has(displayMenuId));
	useManageInput(keyName => {
		// 底部「检查更新」按钮：nav 焦点 + 按钮位 + Enter 键处理
		if (state.focus === 'nav' && state.selectedIndex === menuItems.length && keyName === 'enter') {
			const currentStatus = updateScreen.kind;

			// 'latest' 状态：重新检查更新
			if (currentStatus === 'latest') {
				void runUpdateCheck();
				return;
			}

			// 'available' 状态：打开浮窗确认更新
			if (currentStatus === 'available') {
				setUpdateDialogOpen(true);
				return;
			}

			// 'readyToRestart' / 'updated' / 'error' 状态：打开浮窗确认下一步
			if (currentStatus === 'readyToRestart' || currentStatus === 'updated' || currentStatus === 'error') {
				setUpdateDialogOpen(true);
				return;
			}

			// 'checking' 或 'updating' 状态：无操作
			return;
		}
		setState(current => reduceManageState(current, keyName));
	}, !ownsViewInput);

	// 共享双侧模块（Tools / MCP）隐藏 Header：残留 header 焦点强制回 view，Header 不渲染。
	const hideAgentHeader = AGENT_HEADER_HIDDEN_MODULES.has(displayMenuId);
	const effectiveFocus = hideAgentHeader && state.focus === 'header' ? 'view' : state.focus;
	const navActive = effectiveFocus === 'nav';
	const headerActive = effectiveFocus === 'header' && !hideAgentHeader;

	const sidebarInnerWidth = SIDEBAR_WIDTH - 4;
	const activeFooterShortcuts = footerShortcuts(effectiveFocus, state.selectedIndex === menuItems.length, displayMenuId, viewSubMode);

	// 双卡片双层布局：
	// 左卡片 = Logo（纯色） + 下划线分隔 + menu
	// 右卡片 = content（flexGrow，焦点驱动滚动） + 下划线分隔 + footer

	// Toast 主题配置：根据当前主题动态设置颜色
	const toastOptions = useMemo(
		() => ({
			style: {
				backgroundColor: theme.colors.modalBackground,
				foregroundColor: theme.colors.text,
				borderColor: theme.borderColors.inactive,
				mutedColor: theme.colors.muted,
				borderStyle: 'rounded' as const,
				paddingX: 1,
				paddingY: 0
			},
			duration: 4000,
			success: {
				style: {borderColor: theme.colors.success},
				duration: 3000
			},
			error: {
				style: {borderColor: theme.colors.danger},
				duration: 6000
			},
			warning: {
				style: {borderColor: theme.colors.warning}
			},
			info: {
				style: {borderColor: theme.colors.info}
			}
		}),
		[theme]
	);

	return (
		<>
			<ToastViewport position="bottom-right" stackingMode="stack" visibleToasts={3} toastOptions={toastOptions} />
			<box flexDirection="row" width={terminalWidth} height={terminalHeight}>
				{/* 左侧导航栏 */}
				<box
					flexDirection="column"
					width={SIDEBAR_WIDTH}
					flexShrink={0}
					borderStyle={navActive ? borderStyles.active : borderStyles.inactive}
					borderColor={navActive ? borderColors.active : borderColors.inactive}
					customBorderChars={navActive ? activeBorderChars : undefined}
					paddingX={1}
				>
					{/* Logo 区域：逐行垂直渐变（橙色系，亮→深），制造炫彩光泽；alignItems 居中 */}
					<box flexDirection="column" alignItems="center">
						{CCQ_LOGO.map((line, i) => (
							<text key={i} fg={theme.logoColors[i] ?? PRIMARY} attributes={TextAttributes.BOLD}>
								{line}
							</text>
						))}
					</box>

					<Divider width={sidebarInnerWidth} />

					{/* 菜单列表：active 项用背景高亮条（铺满菜单宽度）+ 粗体三重状态；行间 marginBottom 1 增高行距不显拥挤 */}
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

					{/* 底部固定的「检查更新」按钮（占第 menuItems.length 个导航位，下键可达，Enter 触发） */}
					<UpdateButton
						label={updateButtonLabel(updateScreen.kind)}
						selected={state.selectedIndex === menuItems.length}
						navActive={navActive}
						width={sidebarInnerWidth}
						statusKind={updateStatusKind(updateScreen.kind)}
					/>
				</box>

				{/* 右侧区域：Header 独立固定行，content 卡片占满剩余空间 */}
				<box flexDirection="column" flexGrow={1} minWidth={0}>
					{hideAgentHeader ? null : <AgentHeader agentContext={state.agentContext} active={headerActive} />}

					<box
						flexDirection="column"
						flexGrow={1}
						flexShrink={1}
						minHeight={1}
						borderStyle={effectiveFocus === 'view' ? borderStyles.active : borderStyles.inactive}
						borderColor={effectiveFocus === 'view' ? borderColors.active : borderColors.inactive}
						customBorderChars={effectiveFocus === 'view' ? activeBorderChars : undefined}
						paddingX={1}
					>
						{/* 内容视图区域 */}
						<box flexDirection="column" flexGrow={1} flexShrink={1} minHeight={1} overflow="hidden">
							<ModuleContent
								moduleId={displayMenuId}
								agentContext={state.agentContext}
								contentWidth={contentWidth}
								active={effectiveFocus === 'view' && busyOverlay === null && !updateDialogOpen}
								skillsViewServices={skillsViewServices}
								skillsCache={skillsCache}
								toolsViewServices={toolsViewServices}
								toolsCache={toolsCache}
								onSubModeChange={setViewSubMode}
								onBusyStateChange={setBusyOverlay}
								syntaxStyle={syntaxStyle}
								onExitToNav={() => {
									setViewSubMode('');
									setState(current => reduceManageState(current, 'escape'));
								}}
								onExitToHeader={() => {
									setState(current => reduceManageState(current, 'up'));
								}}
							/>
						</box>

						<Divider width={terminalWidth - SIDEBAR_WIDTH - 4} />

						{/* Footer 快捷键提示 */}
						<ShortcutBar shortcuts={activeFooterShortcuts} width={contentWidth} />
					</box>
				</box>
			</box>

			{/* 检查更新浮窗：确认更新、更新进度与重启确认在同一 Modal 内完成 */}
			<UpdateDialog
				active={updateDialogOpen}
				screen={updateScreen}
				onClose={() => setUpdateDialogOpen(false)}
				onUpdate={plan => void runUpdate(plan)}
				onApplyUpdate={transaction => void applyDownloadedUpdate(transaction)}
				onCancelUpdate={cancelUpdate}
				onRestart={() => void restartUpdatedApp()}
			/>
			{busyOverlay ? (
				<Spinner
					variant="overlay"
					label={busyOverlay.title}
					message={busyOverlay.message}
					terminalWidth={terminalWidth}
					onCancel={busyOverlay.onCancel}
				/>
			) : null}
		</>
	);
}

// 卡片内分区下划线（替代独立 card 边框，Logo/menu 与 content/footer 各自一卡内分隔）
function Divider({width}: {readonly width: number}) {
	return (
		<text fg={colors.muted} flexShrink={0}>
			{'─'.repeat(Math.max(1, width))}
		</text>
	);
}

// Agent 上下文 Header：右侧 content 顶部，全称标签 Claude Code / Codex 切换。
// spec manage-tui-shell：可见标签必须为全称，禁止 cc/cx 缩写；切换不改左侧 6 菜单顺序/选中。
// Header 获焦后用 ←/→ 切换 Agent，并用主题色边框提示焦点。
// 宽度使用百分比铺满父容器，而不是用 contentWidth 估算值写死，避免 Header 比 content 卡片短一截。
function AgentHeader({agentContext, active}: {readonly agentContext: AgentContext; readonly active: boolean}) {
	return (
		<box
			flexDirection="row"
			width="100%"
			flexShrink={0}
			borderStyle={active ? borderStyles.active : borderStyles.inactive}
			borderColor={active ? borderColors.active : borderColors.inactive}
			customBorderChars={active ? activeBorderChars : undefined}
			paddingX={1}
		>
			{AGENT_CONTEXT_ORDER.map(ctx => {
				const selected = ctx === agentContext;
				const label = AGENT_CONTEXT_LABELS[ctx];
				return (
					<box key={ctx} flexDirection="row" marginRight={1}>
						<text
							fg={selected ? colors.navSelectedForeground : colors.muted}
							bg={selected ? PRIMARY : undefined}
							attributes={selected ? TextAttributes.BOLD : 0}
						>
							{` ${label} `}
						</text>
					</box>
				);
			})}
		</box>
	);
}

// 侧边栏导航行（菜单项）：
// 背景高亮条（铺满宽度）+ 粗体三重状态，无选中箭头。
// marginBottom 拉开行距，paddingLeft 增加左侧缩进。
function NavRow({
	label,
	selected,
	navActive,
	width
}: {
	readonly label: string;
	readonly selected: boolean;
	readonly navActive: boolean;
	readonly width: number;
}) {
	const fg = selected ? (navActive ? colors.navSelectedForeground : colors.primary) : colors.muted;
	const bg = selected ? (navActive ? PRIMARY : colors.navInactiveSelectedBackground) : undefined;
	return (
		<box marginBottom={1}>
			<box flexDirection="row" width={width} backgroundColor={bg} paddingLeft={1}>
				<text fg={fg} bg={bg} attributes={selected ? TextAttributes.BOLD : 0}>
					{label}
				</text>
			</box>
		</box>
	);
}

// 底部「检查更新」按钮（独立组件，紧贴底部无下边距）：
// 状态点 + 背景高亮条 + 粗体三重状态，无选中箭头，paddingLeft 增加左侧缩进。
function UpdateButton({
	label,
	selected,
	navActive,
	width,
	statusKind
}: {
	readonly label: string;
	readonly selected: boolean;
	readonly navActive: boolean;
	readonly width: number;
	readonly statusKind: StatusDotKind;
}) {
	const fg = selected ? (navActive ? colors.navSelectedForeground : colors.primary) : colors.muted;
	const bg = selected ? (navActive ? PRIMARY : colors.navInactiveSelectedBackground) : undefined;
	return (
		<box flexDirection="row" width={width} backgroundColor={bg} paddingLeft={1}>
			<text fg={statusDotColor(statusKind)} bg={bg}>
				●{' '}
			</text>
			<text fg={fg} bg={bg} attributes={selected ? TextAttributes.BOLD : 0}>
				{label}
			</text>
		</box>
	);
}

function updateStatusKind(status: UpdateStatus): StatusDotKind {
	switch (status) {
		case 'checking':
		case 'updating':
			return 'updating';
		case 'available':
			return 'updatable';
		case 'latest':
		case 'readyToRestart':
		case 'updated':
			return 'latest';
		case 'error':
			return 'failed';
	}
}

function updateButtonLabel(status: UpdateStatus): string {
	switch (status) {
		case 'checking':
			return '正在检查更新';
		case 'updating':
			return '正在更新';
		case 'available':
			return '发现新版本';
		case 'latest':
			return '已是最新';
		case 'readyToRestart':
			return '等待重启';
		case 'updated':
			return '更新完成';
		case 'error':
			return '更新失败';
	}
}

function UpdateDialog({
	active,
	screen,
	onClose,
	onUpdate,
	onApplyUpdate,
	onCancelUpdate,
	onRestart
}: {
	readonly active: boolean;
	readonly screen: SelfUpdateScreen;
	readonly onClose: () => void;
	readonly onUpdate: (plan: SelfUpdatePlan) => void;
	readonly onApplyUpdate: (transaction: DownloadedSelfUpdate) => void;
	readonly onCancelUpdate: () => void;
	readonly onRestart: () => void;
}) {
	useManageInput(keyName => {
		const isEnter = keyName === 'enter';
		const isEsc = keyName === 'escape';

		if (screen.kind === 'available') {
			if (isEnter) onUpdate(screen.plan);
			else if (isEsc) onClose();
			return;
		}

		if (screen.kind === 'updating') {
			if (isEsc && isSelfUpdateCancellable(screen)) onCancelUpdate();
			return;
		}

		if (screen.kind === 'readyToRestart') {
			if (isEnter) onApplyUpdate(screen.transaction);
			else if (isEsc) onClose();
			return;
		}

		if (screen.kind === 'updated') {
			if (isEnter) onRestart();
			else if (isEsc) onClose();
			return;
		}

		if (screen.kind === 'error') {
			if (isEnter || isEsc) onClose();
			return;
		}

		if (isEnter || isEsc) {
			onClose();
		}
	}, active);

	const content = updateDialogContent(screen);
	return (
		<Modal active={active} title={content.title} hint={content.hint}>
			{content.body}
		</Modal>
	);
}

const UPDATE_PROGRESS_BAR_WIDTH = 24;

export function UpdateProgressBar({progress}: {readonly progress: DownloadUpdateProgress}) {
	const percentage = Math.min(100, Math.max(0, progress.percentage));
	const filledWidth = Math.round((percentage * UPDATE_PROGRESS_BAR_WIDTH) / 100);
	const bar = '='.repeat(filledWidth) + '-'.repeat(UPDATE_PROGRESS_BAR_WIDTH - filledWidth);

	return (
		<box flexDirection="column" marginTop={1}>
			<text fg={colors.primary}>{`[${bar}] ${String(percentage).padStart(3, ' ')}%`}</text>
			<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{`  ${formatDownloadBytes(progress.downloadedBytes)} / ${formatDownloadBytes(progress.totalBytes)}`}
			</text>
		</box>
	);
}

function formatDownloadBytes(bytes: number): string {
	if (bytes < 1024) return `${bytes} B`;
	if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KiB`;
	return `${(bytes / (1024 * 1024)).toFixed(1)} MiB`;
}

function updateDialogContent(screen: SelfUpdateScreen): {readonly title: string; readonly body: React.ReactNode; readonly hint: string} {
	switch (screen.kind) {
		case 'available':
			return {
				title: '发现新版本',
				body: (
					<box flexDirection="column">
						<text
							fg={colors.text}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						>{`  当前 v${CCQ_VERSION}`}</text>
						<text
							fg={colors.text}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						>{`  最新 v${screen.plan.version}`}</text>
					</box>
				),
				hint: 'Enter 更新  Esc 取消'
			};
		case 'updating':
			return {
				title: '正在更新 ccq',
				body: (
					<box flexDirection="column">
						<Spinner label={updateStageLabel(screen.stage)} />
						<text
							fg={colors.muted}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						>{`  目标版本 v${selfUpdateScreenVersion(screen)}`}</text>
						{screen.stage === 'applying' ? null : <UpdateProgressBar progress={screen.progress} />}
					</box>
				),
				hint:
					screen.stage === 'downloading'
						? 'Enter 已禁用  Esc 停止更新'
						: screen.stage === 'cancelling'
							? '正在停止更新...'
							: '正在应用，暂不可取消'
			};
		case 'readyToRestart':
			return {
				title: '下载完成',
				body: (
					<box flexDirection="column">
						<text fg={colors.success} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							更新已下载完成
						</text>
						<text
							fg={colors.muted}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						>{`  新版本 v${screen.transaction.plan.version} 将在重启后生效`}</text>
					</box>
				),
				hint: 'Enter 应用并重启  Esc 稍后处理'
			};
		case 'updated':
			return {
				title: '更新完成',
				body: (
					<box flexDirection="column">
						<text fg={colors.success} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							更新已应用
						</text>
						<text
							fg={colors.muted}
							selectionBg={colors.selectionBg}
							selectionFg={colors.selectionFg}
						>{`  新版本 v${screen.version} 将在重启后生效`}</text>
					</box>
				),
				hint: 'Enter 立即重启  Esc 稍后重启'
			};
		case 'error':
			return {
				title: '更新失败',
				body: (
					<text
						fg={colors.danger}
						selectionBg={colors.selectionBg}
						selectionFg={colors.selectionFg}
					>{`✗ 更新失败：${screen.message}`}</text>
				),
				hint: 'Enter 关闭  Esc 取消'
			};
		default:
			return {
				title: '检查更新',
				body: (
					<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						处理中...
					</text>
				),
				hint: 'Esc 关闭'
			};
	}
}

function updateStageLabel(stage: Extract<SelfUpdateScreen, {readonly kind: 'updating'}>['stage']): string {
	switch (stage) {
		case 'downloading':
			return '正在下载更新...';
		case 'applying':
			return '正在应用更新...';
		case 'cancelling':
			return '正在停止更新...';
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

// Footer 快捷键组装：只展示当前焦点/视图内操作；Agent 切换键仅在 Header 提示，避免 footer 溢出。
function footerShortcuts(
	focus: ManageState['focus'],
	onUpdateButton: boolean,
	displayMenuId: ManageModuleId,
	viewSubMode: string
): readonly Shortcut[] {
	if (focus === 'nav') {
		return onUpdateButton ? updateButtonShortcuts() : navShortcuts();
	}

	if (focus === 'header') {
		return headerShortcuts();
	}

	return viewShortcuts(displayMenuId, viewSubMode);
}

// 右侧内容区路由：六个模块视图
function ModuleContent({
	moduleId,
	agentContext,
	contentWidth,
	active,
	skillsViewServices,
	skillsCache,
	toolsViewServices,
	toolsCache,
	onSubModeChange,
	onBusyStateChange,
	onExitToNav,
	onExitToHeader,
	syntaxStyle
}: {
	readonly moduleId: string;
	readonly agentContext: AgentContext;
	readonly contentWidth: number;
	readonly active: boolean;
	readonly skillsViewServices: ReturnType<typeof createSkillsViewServices>;
	readonly skillsCache: DetectionCache<any>;
	readonly toolsViewServices: ReturnType<typeof createToolsViewServices>;
	readonly toolsCache: DetectionCache<any>;
	readonly onSubModeChange: (subMode: string) => void;
	readonly onBusyStateChange: (state: BusyOverlayState | null) => void;
	readonly onExitToNav: () => void;
	readonly onExitToHeader: () => void;
	readonly syntaxStyle: SyntaxStyle | null;
}) {
	// agentContext 管道已就绪：Tools 视图已消费（Phase 3）；Provider/Config/Prompts/MCP/Skills
	// 视图在 Phase 5-8 逐步落地 agent-aware service 时接入。
	// 根据 moduleId 渲染对应的视图组件
	switch (moduleId) {
		case 'provider':
			return (
				<ProviderView
					agentContext={agentContext}
					active={active}
					onSubModeChange={onSubModeChange}
					onExitToNav={onExitToNav}
					onExitToHeader={onExitToHeader}
				/>
			);
		case 'mcp':
			return <McpView active={active} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		case 'skills':
			return (
				<SkillsView
					services={skillsViewServices}
					cache={skillsCache}
					active={active}
					onSubModeChange={onSubModeChange}
					onBusyStateChange={onBusyStateChange}
					onExitToNav={onExitToNav}
				/>
			);
		case 'prompts':
			return (
				<PromptsView
					agentContext={agentContext}
					active={active}
					onSubModeChange={onSubModeChange}
					onExitToNav={onExitToNav}
					onExitToHeader={onExitToHeader}
					syntaxStyle={syntaxStyle}
				/>
			);
		case 'config':
			return (
				<ConfigView
					agentContext={agentContext}
					active={active}
					onSubModeChange={onSubModeChange}
					onExitToNav={onExitToNav}
					onExitToHeader={onExitToHeader}
					syntaxStyle={syntaxStyle}
				/>
			);
		case 'tools':
			return (
				<ToolsView
					services={toolsViewServices}
					cache={toolsCache}
					active={active}
					contentWidth={contentWidth}
					onSubModeChange={onSubModeChange}
					onBusyStateChange={onBusyStateChange}
					onExitToNav={onExitToNav}
				/>
			);
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
						<text fg={colors.warning}>⚠ 未知模块</text>
					</box>
				</box>
			);
	}
}
