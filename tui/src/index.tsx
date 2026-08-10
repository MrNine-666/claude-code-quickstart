import {createCliRenderer} from '@opentui/core';
import {createRoot} from '@opentui/react';
import {createDefaultOpenTuiKeymap} from '@opentui/keymap/opentui';
import {KeymapProvider} from '@opentui/keymap/react';
import App from './app.js';
import {setActiveTheme, type AppThemeMode} from './theme/index.js';
import {parseCli} from './cli/argv.js';
import {runCli} from './cli/index.js';
import {copyTextWithFeedback} from './utils/copy-feedback.js';
import {isAppModifier} from './utils/keyboard.js';
import {createTuiExitController} from './core/tui-exit.js';

// argv 子命令路由（HC-CLI-SUBCOMMAND）：有子命令 → 走非交互路径，不进 TUI。
// 必须在 non-TTY 守卫之前执行，否则管道/CI 下 ccq ls 等命令会被守卫挡掉。
const cliIntent = parseCli(process.argv.slice(2));
if (cliIntent.kind !== 'tui') {
	// 子命令不依赖 TUI；失败兜底，异常不影响无参 TUI 路径（无参不经此分支）。
	try {
		const code = await runCli(cliIntent);
		process.exit(code);
	} catch (error) {
		const msg = error instanceof Error ? error.message : String(error);
		console.error(`ccq: ${msg}`);
		process.exit(1);
	}
}

// non-TTY 守卫：仅当「无子命令 + 非 TTY」时输出只读提示并退出（对齐 HC-NON-TTY）。
// 有子命令的分支已在上方 process.exit 提前返回，不会到达此处。
if (!process.stdin.isTTY) {
	console.log('Claude Code Quickstart 管理控制台');
	console.log('此工具需要交互式终端（TTY）运行。');
	console.log('请在交互式终端中直接运行 ccq 命令。');
	process.exit(0);
}

const exitController = createTuiExitController();
const renderer = await createCliRenderer({
	autoFocus: true, // 启用自动聚焦，确保键盘事件能被捕获
	exitOnCtrlC: false, // 释放 Ctrl+C 给终端复制；应用内退出使用 q
	onDestroy: exitController.handleRendererDestroyed
});

// copy-on-select：鼠标拖选只读预览文本（CodePreview 的 <text selectable>）后自动复制到剪贴板。
// 编辑态 textarea 的复制由 textarea-edit-keys 的 Cmd/Ctrl+C 自管，此处只覆盖只读预览区。
// 复制成功弹 toast 反馈，终端不支持 / 无选中文本时静默跳过（见 copyTextWithFeedback）。
renderer.on('selection', selection => {
	copyTextWithFeedback(renderer, selection.getSelectedText());
});
// 调试控制台：TUI 接管了 stdout，直接 console.log 会被渲染帧覆盖看不见。OpenTUI 自带
// TerminalConsole 覆盖层，把 console.* 收进可滚动面板；consoleMode 默认已是
// 'console-overlay'，只需按需 show/toggle。
//
// 键位用 Ctrl+G 而非 F-key：macOS 上 F9 被 Mission Control / 媒体键占用，需按住 Fn 才是裸
// F9，且不少终端不转发；Ctrl+G 历史含义是 BEL，现代 TUI 基本不用。与本项目 appShortcutKey
// 的 ctrl+<key> 约定一致（全平台 Ctrl，不用 Cmd），且 ctrl+o / ctrl+t 已被占用，g 是空的。
//
// 开关来源：dev 由 .env.development 提供 CCQ_DEBUG=1（bun run dev 设了 NODE_ENV=development，
// Bun 据此自动加载该文件）。生产二进制构建时传了 --no-compile-autoload-dotenv，不读任何
// .env，因此默认关闭；仍可用 `CCQ_DEBUG=1 ccq` 从 shell 显式打开，作为线上排查的逃生口。
if (process.env.CCQ_DEBUG === '1') {
	renderer.console.show();
	renderer.keyInput.on('keypress', key => {
		if (key.name === 'g' && isAppModifier(key)) {
			renderer.console.toggle();
		}
	});
}

// @opentui/keymap 自带 @opentui/core 依赖；Bun 会保留一份嵌套副本。
// 运行时版本已对齐到 0.4.5，这里只做 CliRenderer 私有类型桥接。
const keymap = createDefaultOpenTuiKeymap(renderer as never);

// 终端主题检测：OpenTUI 用 DEC 2031 实时上报 + OSC 10/11 亮度回退；
// waitForThemeMode 短暂阻塞首帧以确定 dark/light，超时返回 null → 默认 dark。
// 主题确定后注入 theme/index.ts 的 activeTheme，随后 App 内 theme_mode 事件负责实时跟随。
const detectedMode = await renderer.waitForThemeMode(500);
const initialThemeMode: AppThemeMode = detectedMode === 'light' ? 'light' : 'dark';
setActiveTheme(initialThemeMode);
const requestTuiExit = (): void => {
	exitController.requestExit(renderer);
};

createRoot(renderer).render(
	<KeymapProvider keymap={keymap}>
		<App initialThemeMode={initialThemeMode} onExit={requestTuiExit} />
	</KeymapProvider>
);
