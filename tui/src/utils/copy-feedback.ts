import type {CliRenderer} from '@opentui/core';
import {toast} from '../components/toast.js';

// 复制反馈统一入口（HC-COPY-FEEDBACK）：所有 OSC52 复制走此函数，成功即弹 toast。
// 覆盖两类复制场景：
//   1. copy-on-select（只读预览 CodePreview 的 <text selectable> 拖选，index.tsx 注册）；
//   2. 编辑态 Cmd/Ctrl+C 选中复制（textarea-edit-keys 共用，供 Config/Prompts/Provider/MCP 表单）。
// 终端不支持 OSC52、无 renderer 或文本为空时静默跳过（不弹成功 toast，命中即 return false）。

/**
 * 通过 OSC52 复制文本到系统剪贴板，成功时弹「已复制到剪贴板」toast。
 * @returns 复制是否成功（终端不支持 / 无文本 / 写入失败均返回 false，不弹 toast）。
 */
export function copyTextWithFeedback(renderer: CliRenderer | null, text: string): boolean {
	if (!renderer || text.length === 0 || !renderer.isOsc52Supported()) {
		return false;
	}

	const ok = renderer.copyToClipboardOSC52(text);
	if (ok) {
		toast.success('已复制到剪贴板', 2000);
	}

	return ok;
}
