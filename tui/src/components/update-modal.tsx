import React, { useEffect, useState } from 'react';
import { TextAttributes } from '@opentui/core';
import { useKeyboard, useRenderer } from '@opentui/react';
import { colors, PRIMARY } from '../theme/index.js';
import { toast } from './toast.js';
import { CCQ_VERSION } from '../version.js';
import { applyUpdate, checkLatestVersion, downloadUpdate, restartExecutable } from '../core/update.js';

// 检查更新浮窗：底部「检查更新」按钮回车触发，position=absolute 居中浮在主界面上层（zIndex=100），
// 非独立页面（不占右侧内容区、不进 view 路由），主界面菜单保留背后。内部状态机：
// checking → latest/available → downloading → applying → confirm-restart → updated/error。
// 复用 core/update.ts 整可执行文件热更新链路（Phase 7.5-7.8）。平台差异：
//   - macOS/Linux：applyUpdate 当场原子替换磁盘文件，重启即新版
//   - Windows：运行中 exe 文件锁，applyUpdate 仅就绪 .ccq-update.tmp，靠重启时收尾

type ModalScreen =
	| { readonly kind: 'checking' }
	| { readonly kind: 'latest' }
	| { readonly kind: 'available'; readonly version: string; readonly downloadUrl: string }
	| { readonly kind: 'downloading'; readonly version: string }
	| { readonly kind: 'applying' }
	| { readonly kind: 'confirm-restart'; readonly version: string }
	| { readonly kind: 'updated'; readonly version: string }
	| { readonly kind: 'error'; readonly message: string };

export type UpdateModalStatus = ModalScreen['kind'];

export type UpdateModalProps = {
	readonly active: boolean;
	readonly onClose: () => void;
	readonly onStatusChange?: (status: UpdateModalStatus) => void;
	readonly viewportWidth: number;
	readonly viewportHeight: number;
};

const MODAL_WIDTH = 40;
const MODAL_HEIGHT = 8;

export function UpdateModal({ active, onClose, onStatusChange, viewportWidth, viewportHeight }: UpdateModalProps) {
	const renderer = useRenderer();
	const [screen, setScreen] = useState<ModalScreen>({ kind: 'checking' });

	useEffect(() => {
		onStatusChange?.(screen.kind);
	}, [onStatusChange, screen.kind]);

	const runCheck = async (): Promise<void> => {
		setScreen({ kind: 'checking' });
		const info = await checkLatestVersion();
		if (!info) {
			setScreen({ kind: 'latest' });
		} else {
			setScreen({ kind: 'available', version: info.version, downloadUrl: info.downloadUrl });
		}
	};

	const runUpdate = async (version: string, downloadUrl: string): Promise<void> => {
		setScreen({ kind: 'downloading', version });
		const downloaded = await downloadUpdate(downloadUrl);
		if (!downloaded) {
			toast.error('下载更新失败，请检查网络后重试');
			setScreen({ kind: 'error', message: '下载失败' });
			return;
		}

		setScreen({ kind: 'applying' });
		const applied = await applyUpdate();
		if (!applied) {
			toast.error('应用更新失败');
			setScreen({ kind: 'error', message: '应用更新失败' });
			return;
		}

		toast.success(process.platform === 'win32' ? '更新已就绪，重启 ccq 后自动完成' : '更新完成，重启 ccq 生效');
		setScreen({ kind: 'confirm-restart', version });
	};

	const doRestart = (): void => {
		// 先恢复终端 raw mode，再 spawn detached 新进程并退出当前进程
		renderer?.destroy();
		restartExecutable();
	};

	// 浮窗打开时自动检查（active false→true 触发）
	useEffect(() => {
		if (!active) return;
		void runCheck();
		// 依赖 [active]：runCheck 仅依赖稳定的 setScreen 与模块级 checkLatestVersion
		// eslint-disable-next-line react-hooks/exhaustive-deps
	}, [active]);

	useKeyboard((keyEvent) => {
		if (!active) return;
		const key = keyEvent.name;
		const isEnter = key === 'enter' || key === 'return';
		const isEsc = key === 'escape';

		// 更新完成确认：Enter 立即重启 / Esc 稍后（进入 updated 静态态）
		if (screen.kind === 'confirm-restart') {
			if (isEnter) doRestart();
			else if (isEsc) setScreen({ kind: 'updated', version: screen.version });
			return;
		}

		// 发现新版本：Enter 下载并更新 / Esc 关闭
		if (screen.kind === 'available') {
			if (isEnter) void runUpdate(screen.version, screen.downloadUrl);
			else if (isEsc) onClose();
			return;
		}

		// 执行中（检查 / 下载 / 应用）：仅 Esc 可关闭，避免误触
		if (screen.kind === 'checking' || screen.kind === 'downloading' || screen.kind === 'applying') {
			if (isEsc) onClose();
			return;
		}

		// latest / updated / error：Enter 或 Esc 关闭浮窗
		if (isEnter || isEsc) onClose();
	});

	if (!active) return null;

	const content = renderContent(screen);
	const left = Math.max(0, Math.floor((viewportWidth - MODAL_WIDTH) / 2));
	const top = Math.max(0, Math.floor((viewportHeight - MODAL_HEIGHT) / 2));

	return (
		<box
			position="absolute"
			left={left}
			top={top}
			width={MODAL_WIDTH}
			height={MODAL_HEIGHT}
			zIndex={100}
			flexDirection="column"
			borderStyle="rounded"
			borderColor={PRIMARY}
			paddingX={1}
		>
			<text fg={PRIMARY} attributes={TextAttributes.BOLD}>{content.title}</text>
			<text fg={colors.muted}>{'─'.repeat(MODAL_WIDTH - 4)}</text>
			{content.body}
			<box flexGrow={1} />
			<text fg={colors.muted} attributes={TextAttributes.DIM}>{content.hint}</text>
		</box>
	);
}

// 按 screen.kind 渲染浮窗标题 / 正文 / 底部按键提示
function renderContent(screen: ModalScreen): { readonly title: string; readonly body: React.ReactNode; readonly hint: string } {
	switch (screen.kind) {
		case 'checking':
			return { title: '检查更新', body: <text fg={colors.muted}>正在检查最新版本...</text>, hint: 'Esc 取消' };
		case 'latest':
			return {
				title: '检查更新',
				body: (
					<box flexDirection="column">
						<text fg={colors.success}>✓ 已是最新版本</text>
						<text fg={colors.muted}>{`  当前 v${CCQ_VERSION}`}</text>
					</box>
				),
				hint: 'Esc 关闭'
			};
		case 'available':
			return {
				title: '检查更新',
				body: (
					<box flexDirection="column">
						<text fg={PRIMARY}>发现新版本</text>
						<text fg={colors.muted}>{`  当前 v${CCQ_VERSION}`}</text>
						<text fg={colors.muted}>{`  最新 v${screen.version}`}</text>
					</box>
				),
				hint: 'Enter 更新  Esc 取消'
			};
		case 'downloading':
			return { title: '检查更新', body: <text fg={colors.muted}>{`正在下载 v${screen.version}...`}</text>, hint: 'Esc 取消' };
		case 'applying':
			return { title: '检查更新', body: <text fg={colors.muted}>正在应用更新...</text>, hint: 'Esc 取消' };
		case 'confirm-restart':
			return {
				title: '更新完成',
				body: (
					<box flexDirection="column">
						<text fg={colors.success}>{`✓ 已更新到 v${screen.version}`}</text>
						<text>是否立即重启 ccq？</text>
					</box>
				),
				hint: 'Enter 重启  Esc 稍后'
			};
		case 'updated':
			return {
				title: '更新完成',
				body: (
					<box flexDirection="column">
						<text fg={colors.success}>{`✓ 已更新到 v${screen.version}`}</text>
						<text fg={colors.muted}>重启 ccq 后生效</text>
					</box>
				),
				hint: 'Esc 关闭'
			};
		case 'error':
			return { title: '检查更新', body: <text fg={colors.danger}>{`✗ 更新失败：${screen.message}`}</text>, hint: 'Esc 关闭' };
	}
}
