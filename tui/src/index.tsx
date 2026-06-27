import { createCliRenderer } from "@opentui/core";
import { createRoot } from "@opentui/react";
import { createDefaultOpenTuiKeymap } from "@opentui/keymap/opentui";
import { KeymapProvider } from "@opentui/keymap/react";
import App from "./app.js";
import { applyPendingUpdateOnStartup, startBackgroundUpdateCheck } from "./core/update.js";

// non-TTY 守卫：管道/重定向时输出只读提示，不进交互 TUI（对齐 HC-NON-TTY）
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

createRoot(renderer).render(
	<KeymapProvider keymap={keymap}>
		<App />
	</KeymapProvider>
);
