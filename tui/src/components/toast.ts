// Toast 操作反馈入口（自实现，替代 @opentui-ui/toast）
// 状态在 toast-store.ts，渲染在 toast-viewport.tsx；此文件只做对外聚合导出，
// 保持既有 52 处调用点的 import 路径不变。

export {toast, resetToasts, TOAST_DURATION, MAX_VISIBLE_TOASTS, type ToastType, type ToastEntry} from './toast-store.js';
export {ToastViewport} from './toast-viewport.js';
