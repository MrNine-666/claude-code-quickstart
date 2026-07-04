import { existsSync } from 'node:fs';
import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useRenderer } from '@opentui/react';
import { TextAttributes, getTreeSitterClient, SyntaxStyle, RGBA, type ThemeMode as OpenTuiThemeMode } from '@opentui/core';
import { useManageInput } from './hooks/use-manage-input.js';
import { useDetectionCache, type DetectionCache } from './hooks/use-detection-cache.js';
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
import { navShortcuts, viewShortcuts, updateButtonShortcuts, agentToggleShortcut } from './state/shortcuts.js';
import { Modal, ShortcutBar, Spinner, ToastViewport, toast, type Shortcut, type StatusDotKind } from './components/index.js';
import { colors, borderColors, borderStyles, PRIMARY, getTheme, setActiveTheme, type AppThemeMode, type ThemePalette } from './theme/index.js';
import { CCQ_LOGO } from './theme/logo.js';
import { CCQ_VERSION } from './version.js';
import { applyUpdate, checkLatestVersion, downloadUpdate, restartExecutable } from './core/update.js';
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

// 是否运行在 Bun --compile 单文件可执行产物中。
// 源码模式下 import.meta.dirname 是真实磁盘目录（existsSync=true）；
// 编译产物下它是 Bun 虚拟路径（如 B:\~BUN\root），existsSync=false。
// Tree-sitter worker 在编译产物中无法被正确嵌入/解析（Bun compile 不会嵌入
// new Worker(new URL(...)) 动态引用的 worker 文件，且 existsSync 失效导致
// OpenTUI 回退到不存在的 parser.worker.ts），故编译产物下禁用语法高亮、降级纯文本。
const IS_COMPILED_EXECUTABLE = import.meta.dirname != null && !existsSync(import.meta.dirname);

type UpdateScreen =
	| { readonly kind: 'checking' }
	| { readonly kind: 'latest' }
	| { readonly kind: 'available'; readonly version: string; readonly downloadUrl: string }
	| { readonly kind: 'updating'; readonly version: string; readonly downloadUrl: string; readonly stage: 'downloading' | 'applying' | 'cancelling' }
	| { readonly kind: 'updated'; readonly version: string }
	| { readonly kind: 'error'; readonly message: string };

type UpdateStatus = UpdateScreen['kind'];

type AppProps = {
	readonly initialThemeMode: AppThemeMode;
};

function normalizeThemeMode(mode: OpenTuiThemeMode | null | undefined): AppThemeMode {
	return mode === 'light' ? 'light' : 'dark';
}

function createSyntaxStyle(theme: ThemePalette): SyntaxStyle {
	const { syntax } = theme;
	return SyntaxStyle.fromStyles({
		// code token（fenced code block：TS/JS）
		keyword: { fg: RGBA.fromHex(syntax.keyword), bold: true },
		string: { fg: RGBA.fromHex(syntax.string) },
		number: { fg: RGBA.fromHex(syntax.number) },
		comment: { fg: RGBA.fromHex(syntax.comment), italic: true },
		function: { fg: RGBA.fromHex(syntax.function) },
		type: { fg: RGBA.fromHex(syntax.type) },
		operator: { fg: RGBA.fromHex(syntax.operator) },
		// markdown markup token（全局规则页 CLAUDE.md：标题/粗体/列表/引用/代码/链接着色）
		'markup.heading': { fg: RGBA.fromHex(syntax.markupHeading), bold: true },
		'markup.heading.1': { fg: RGBA.fromHex(syntax.markupHeading1), bold: true },
		'markup.heading.2': { fg: RGBA.fromHex(syntax.markupHeading2), bold: true },
		'markup.heading.3': { fg: RGBA.fromHex(syntax.markupHeading3), bold: true },
		'markup.bold': { fg: RGBA.fromHex(syntax.markupBold), bold: true },
		'markup.strong': { fg: RGBA.fromHex(syntax.markupBold), bold: true },
		'markup.italic': { fg: RGBA.fromHex(syntax.markupBold), italic: true },
		'markup.list': { fg: RGBA.fromHex(syntax.markupList) },
		'markup.list.checked': { fg: RGBA.fromHex(syntax.markupListChecked) },
		'markup.quote': { fg: RGBA.fromHex(syntax.markupQuote), italic: true },
		'markup.raw': { fg: RGBA.fromHex(syntax.markupRaw) },
		'markup.raw.block': { fg: RGBA.fromHex(syntax.markupRaw) },
		'markup.link': { fg: RGBA.fromHex(syntax.markupLink), underline: true },
		'markup.link.url': { fg: RGBA.fromHex(syntax.markupLink), underline: true },
		default: { fg: RGBA.fromHex(syntax.default) }
	});
}

export default function App({ initialThemeMode }: AppProps) {
	const [themeMode, setThemeMode] = useState<AppThemeMode>(initialThemeMode);
	const theme = useMemo(() => getTheme(themeMode), [themeMode]);
	const [state, setState] = useState(createInitialManageState);
	const [viewSubMode, setViewSubMode] = useState<string>('');
	const [updateDialogOpen, setUpdateDialogOpen] = useState(false);
	const [updateScreen, setUpdateScreen] = useState<UpdateScreen>({ kind: 'checking' });
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

	const runUpdateCheck = async (): Promise<void> => {
		setUpdateScreen({ kind: 'checking' });
		const info = await checkLatestVersion();
		setUpdateScreen(info ? { kind: 'available', version: info.version, downloadUrl: info.downloadUrl } : { kind: 'latest' });
	};

	const restartUpdatedApp = (): void => {
		renderer?.destroy();
		restartExecutable();
	};

	const cancelUpdate = (): void => {
		const controller = updateAbortRef.current;
		if (!controller) {
			return;
		}

		controller.abort();
		setUpdateScreen(current => current.kind === 'updating' ? {...current, stage: 'cancelling'} : current);
	};

	const runUpdate = async (version: string, downloadUrl: string): Promise<void> => {
		const abortController = new AbortController();
		updateAbortRef.current = abortController;
		setUpdateDialogOpen(true);
		setUpdateScreen({ kind: 'updating', version, downloadUrl, stage: 'downloading' });

		const downloaded = await downloadUpdate(downloadUrl, abortController.signal);
		if (abortController.signal.aborted) {
			updateAbortRef.current = null;
			setUpdateScreen({ kind: 'available', version, downloadUrl });
			return;
		}

		if (!downloaded) {
			updateAbortRef.current = null;
			toast.error('下载更新失败，请检查网络后重试');
			setUpdateScreen({ kind: 'error', message: '下载失败' });
			return;
		}

		setUpdateScreen({ kind: 'updating', version, downloadUrl, stage: 'applying' });
		const applied = await applyUpdate();
		updateAbortRef.current = null;
		if (!applied) {
			toast.error('应用更新失败');
			setUpdateScreen({ kind: 'error', message: '应用更新失败' });
			return;
		}

		setUpdateScreen({ kind: 'updated', version });
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
	const ownsViewInput = updateDialogOpen || (state.focus === 'view' && viewModulesWithInput.has(displayMenuId));
	useManageInput(keyName => {
		// 底部「检查更新」按钮：nav 焦点 + 按钮位 + Enter 键处理
		if (
			state.focus === 'nav' &&
			state.selectedIndex === menuItems.length &&
			keyName === 'enter'
		) {
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

			// 'updated' / 'error' 状态：打开浮窗确认下一步
			if (currentStatus === 'updated' || currentStatus === 'error') {
				setUpdateDialogOpen(true);
				return;
			}

			// 'checking' 或 'updating' 状态：无操作
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

	// Toast 主题配置：根据当前主题动态设置颜色
	const toastOptions = useMemo(() => ({
		style: {
			backgroundColor: theme.colors.modalBackground,
			foregroundColor: theme.colors.text,
			borderColor: theme.borderColors.inactive,
			mutedColor: theme.colors.muted,
			borderStyle: 'rounded' as const,
			paddingX: 1,
			paddingY: 0,
		},
		duration: 4000,
		success: {
			style: { borderColor: theme.colors.success },
			duration: 3000,
		},
		error: {
			style: { borderColor: theme.colors.danger },
			duration: 6000,
		},
		warning: {
			style: { borderColor: theme.colors.warning },
		},
		info: {
			style: { borderColor: theme.colors.info },
		},
	}), [theme]);

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

				{/* 右侧内容区 */}
				<box
					flexDirection="column"
					flexGrow={1}
					borderStyle={!navActive ? borderStyles.active : borderStyles.inactive}
					borderColor={!navActive ? borderColors.active : borderColors.inactive}
					paddingX={1}
				>
					{/* Agent 上下文 Header（全称切换 Claude Code / Codex，shift+tab 切换；不展示 cc/cx 缩写） */}
					<AgentHeader agentContext={state.agentContext} />

					{/* 内容视图区域 */}
					<box flexDirection="column" flexGrow={1} height={contentViewportHeight} overflow="hidden">
						<ModuleContent
							moduleId={displayMenuId}
							agentContext={state.agentContext}
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
					<ShortcutBar shortcuts={footerShortcuts(navActive, state.selectedIndex === menuItems.length, displayMenuId, viewSubMode)} />
				</box>
			</box>

			{/* 检查更新浮窗：确认更新、更新进度与重启确认在同一 Modal 内完成 */}
			<UpdateDialog
				active={updateDialogOpen}
				screen={updateScreen}
				viewportWidth={terminalWidth}
				viewportHeight={terminalHeight}
				onClose={() => setUpdateDialogOpen(false)}
				onUpdate={(version, downloadUrl) => void runUpdate(version, downloadUrl)}
				onCancelUpdate={cancelUpdate}
				onRestart={restartUpdatedApp}
			/>
		</>
	);
}

// 卡片内分区下划线（替代独立 card 边框，Logo/menu 与 content/footer 各自一卡内分隔）
function Divider({ width }: { readonly width: number }) {
	return <text fg={colors.muted}>{'─'.repeat(Math.max(1, width))}</text>;
}

// Agent 上下文 Header：右侧 content 顶部，全称标签 Claude Code / Codex 切换。
// spec manage-tui-shell：可见标签必须为全称，禁止 cc/cx 缩写；切换不改左侧 6 菜单顺序/选中。
// 切换键 shift+tab 由 reduceManageState 处理；Header 只反映 state.agentContext。
function AgentHeader({ agentContext }: { readonly agentContext: AgentContext }) {
	return (
		<box flexDirection="row" marginBottom={0}>
			{AGENT_CONTEXT_ORDER.map(ctx => {
				const active = ctx === agentContext;
				const label = AGENT_CONTEXT_LABELS[ctx];
				return (
					<box key={ctx} flexDirection="row" marginRight={2}>
						<text fg={active ? PRIMARY : colors.muted} attributes={active ? TextAttributes.BOLD : 0}>
							{active ? '▶ ' : '  '}
						</text>
						<text fg={active ? PRIMARY : colors.muted} attributes={active ? TextAttributes.BOLD : 0}>
							{label}
						</text>
					</box>
				);
			})}
			<text fg={colors.muted} attributes={TextAttributes.DIM}>{`  ${agentToggleShortcut().key} 切换`}</text>
		</box>
	);
}

// 侧边栏导航行（菜单项）：
// 背景高亮条（铺满宽度）+ 粗体三重状态，无选中箭头。
// marginBottom 拉开行距，paddingLeft 增加左侧缩进。
function NavRow({ label, selected, navActive, width }: {
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
				<text
					fg={fg}
					bg={bg}
					attributes={selected ? TextAttributes.BOLD : 0}
				>
					{label}
				</text>
			</box>
		</box>
	);
}

// 底部「检查更新」按钮（独立组件，紧贴底部无下边距）：
// 状态点 + 背景高亮条 + 粗体三重状态，无选中箭头，paddingLeft 增加左侧缩进。
function UpdateButton({ label, selected, navActive, width, statusKind }: {
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
			<text fg={statusDotColor(statusKind)} bg={bg}>● </text>
			<text
				fg={fg}
				bg={bg}
				attributes={selected ? TextAttributes.BOLD : 0}
			>
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
		case 'updated':
			return '等待重启';
		case 'error':
			return '更新失败';
	}
}

function UpdateDialog({
	active,
	screen,
	viewportWidth,
	viewportHeight,
	onClose,
	onUpdate,
	onCancelUpdate,
	onRestart
}: {
	readonly active: boolean;
	readonly screen: UpdateScreen;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
	readonly onClose: () => void;
	readonly onUpdate: (version: string, downloadUrl: string) => void;
	readonly onCancelUpdate: () => void;
	readonly onRestart: () => void;
}) {
	useManageInput((keyName) => {
		const isEnter = keyName === 'enter';
		const isEsc = keyName === 'escape';

		if (screen.kind === 'available') {
			if (isEnter) onUpdate(screen.version, screen.downloadUrl);
			else if (isEsc) onClose();
			return;
		}

		if (screen.kind === 'updating') {
			if (isEsc) onCancelUpdate();
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
		<Modal active={active} title={content.title} hint={content.hint} viewportWidth={viewportWidth} viewportHeight={viewportHeight}>
			{content.body}
		</Modal>
	);
}

function updateDialogContent(screen: UpdateScreen): { readonly title: string; readonly body: React.ReactNode; readonly hint: string } {
	switch (screen.kind) {
		case 'available':
			return {
				title: '发现新版本',
				body: (
					<box flexDirection="column">
						<text fg={PRIMARY} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>发现新版本</text>
						<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{`  当前 v${CCQ_VERSION}`}</text>
						<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{`  最新 v${screen.version}`}</text>
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
						<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{`  目标版本 v${screen.version}`}</text>
					</box>
				),
				hint: screen.stage === 'cancelling' ? '正在停止更新...' : 'Enter 已禁用  Esc 停止更新'
			};
		case 'updated':
			return {
				title: '更新完成',
				body: (
					<box flexDirection="column">
						<text fg={colors.success} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>更新已准备就绪</text>
						<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{`  新版本 v${screen.version} 将在重启后生效`}</text>
					</box>
				),
				hint: 'Enter 立即重启  Esc 稍后重启'
			};
		case 'error':
			return { title: '更新失败', body: <text fg={colors.danger} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>{`✗ 更新失败：${screen.message}`}</text>, hint: 'Enter 关闭  Esc 取消' };
		default:
			return { title: '检查更新', body: <text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>处理中...</text>, hint: 'Esc 关闭' };
	}
}

function updateStageLabel(stage: Extract<UpdateScreen, {readonly kind: 'updating'}>['stage']): string {
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

// Footer 快捷键组装：nav 焦点用 nav/更新按钮键位；view 焦点用视图键位 + 追加「切换 Agent」。
// Header 切换（shift+tab）在 nav 与 view 顶层焦点均可用，故两者 footer 都含切换项（单一数据源）。
function footerShortcuts(
	navActive: boolean,
	onUpdateButton: boolean,
	displayMenuId: ManageModuleId,
	viewSubMode: string
): readonly Shortcut[] {
	if (navActive) {
		return onUpdateButton ? updateButtonShortcuts() : navShortcuts();
	}

	return [...viewShortcuts(displayMenuId, viewSubMode), agentToggleShortcut()];
}

// 右侧内容区路由：六个模块视图
function ModuleContent({
	moduleId,
	agentContext,
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
	readonly agentContext: AgentContext;
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
	// agentContext 管道已就绪：Tools 视图已消费（Phase 3）；Provider/Config/Prompts/MCP/Skills
	// 视图在 Phase 5-8 逐步落地 agent-aware service 时接入。
	// 根据 moduleId 渲染对应的视图组件
	switch (moduleId) {
		case 'provider':
			return <ProviderView active={active} viewportHeight={viewportHeight} viewportWidth={contentWidth} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		case 'mcp':
			return <McpView active={active} viewportHeight={viewportHeight} viewportWidth={contentWidth} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		case 'skills':
			return <SkillsView services={skillsViewServices} cache={skillsCache} active={active} viewportHeight={viewportHeight} viewportWidth={contentWidth} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
		case 'prompts':
			return <PromptsView active={active} viewportHeight={viewportHeight} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} syntaxStyle={syntaxStyle} />;
		case 'config':
			return <ConfigView active={active} viewportHeight={viewportHeight} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} syntaxStyle={syntaxStyle} />;
		case 'tools':
			return <ToolsView services={toolsViewServices} cache={toolsCache} agentContext={agentContext} active={active} viewportHeight={viewportHeight} viewportWidth={contentWidth} contentWidth={contentWidth} onSubModeChange={onSubModeChange} onExitToNav={onExitToNav} />;
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
