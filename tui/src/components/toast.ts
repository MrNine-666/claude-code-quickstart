// Toast 操作反馈封装（@opentui-ui/toast）
// 用于显示操作成功/失败/警告等短暂提示

import { Toaster, toast as openTuiToast } from '@opentui-ui/toast/react';

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export type ToastOptions = {
	readonly type: ToastType;
	readonly message: string;
	readonly duration?: number;
};

function toastOptions(duration?: number): { readonly duration: number } | undefined {
	return duration === undefined ? undefined : {duration};
}

export const ToastViewport = Toaster;

export const toast = {
	success: (message: string, duration?: number) => {
		openTuiToast.success(message, toastOptions(duration));
	},
	error: (message: string, duration?: number) => {
		openTuiToast.error(message, toastOptions(duration));
	},
	warning: (message: string, duration?: number) => {
		openTuiToast.warning(message, toastOptions(duration));
	},
	info: (message: string, duration?: number) => {
		openTuiToast.info(message, toastOptions(duration));
	}
};
