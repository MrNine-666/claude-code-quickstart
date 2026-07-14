import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import App from "./app.js";
import { setActiveTheme, type AppThemeMode } from "./theme/index.js";
import { parseCli } from "./cli/argv.js";
import { runCli } from "./cli/index.js";
import { copyTextWithFeedback } from "./utils/copy-feedback.js";

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

const renderer = await createCliRenderer({
	autoFocus: true,  // 启用自动聚焦，确保键盘事件能被捕获
	exitOnCtrlC: false  // 释放 Ctrl+C 给终端复制；应用内退出使用 q
});

// copy-on-select：鼠标拖选只读预览文本（CodePreview 的 <text selectable>）后自动复制到剪贴板。
// 编辑态 textarea 的复制由 textarea-edit-keys 的 Cmd/Ctrl+C 自管，此处只覆盖只读预览区。
// 复制成功弹 toast 反馈，终端不支持 / 无选中文本时静默跳过（见 copyTextWithFeedback）。
renderer.on('selection', (selection) => {
	copyTextWithFeedback(renderer, selection.getSelectedText());
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
