import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import App from "./app.js";
import { applyPendingUpdateOnStartup, startBackgroundUpdateCheck } from "./core/update.js";
import { setActiveTheme, type AppThemeMode } from "./theme/index.js";
import { parseCli } from "./cli/argv.js";
import { runCli } from "./cli/index.js";

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

// Windows 启动时检查并应用待替换的更新（Phase 7.5）
const appliedUpdate = await applyPendingUpdateOnStartup();
if (appliedUpdate) {
	console.log('✓ ccq 已更新到最新版本');
}

// 启动后台自动检查更新（Phase 7.5，不阻塞主流程）
startBackgroundUpdateCheck();


const renderer = await createCliRenderer({
	autoFocus: true,  // 启用自动聚焦，确保键盘事件能被捕获
	exitOnCtrlC: false  // 释放 Ctrl+C 给终端复制；应用内退出使用 q
});
// @opentui/keymap 自带 @opentui/core 依赖；Bun 会保留一份嵌套副本。
// 运行时版本已对齐到 0.4.2，这里只做 CliRenderer 私有类型桥接。
const keymap = createDefaultOpenTuiKeymap(renderer as never);

// 终端主题检测：OpenTUI 用 DEC 2031 实时上报 + OSC 10/11 亮度回退；
// waitForThemeMode 短暂阻塞首帧以确定 dark/light，超时返回 null → 默认 dark。
// 主题确定后注入 theme/index.ts 的 activeTheme，随后 App 内 theme_mode 事件负责实时跟随。
const detectedMode = await renderer.waitForThemeMode(500);
const initialThemeMode: AppThemeMode = detectedMode === 'light' ? 'light' : 'dark';
setActiveTheme(initialThemeMode);

createRoot(renderer).render(
	<KeymapProvider keymap={keymap}>
		<App initialThemeMode={initialThemeMode} />
	</KeymapProvider>
);
