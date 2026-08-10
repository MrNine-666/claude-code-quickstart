// Toast 状态存储（模块级单例）
//
// 为什么自实现：@opentui-ui/toast@0.0.5 的 peer 是 @opentui/core ^0.1.63，而本项目运行在
// 0.4.5。0.4.5 把 Renderable.remove() 的签名从 remove(id) 改成 remove(child) 并加了
// instanceof 强校验，该包内部仍传 id 字符串，每次 toast 消失都会抛
// "remove expects a renderable child object"。自实现改用 JSX 声明式渲染，节点增删交给
// React reconciler，彻底绕开这个 breaking change。

export type ToastType = 'success' | 'error' | 'warning' | 'info';

export type ToastEntry = {
	readonly id: number;
	readonly type: ToastType;
	readonly message: string;
};

/** 各类型默认停留时长（ms），与原 @opentui-ui/toast 配置保持一致。 */
export const TOAST_DURATION: Readonly<Record<ToastType, number>> = {
	success: 3000,
	error: 6000,
	warning: 4000,
	info: 4000
};

/** 同时可见的最大条数；超出时丢弃最旧的一条。 */
export const MAX_VISIBLE_TOASTS = 3;

type Listener = () => void;

let entries: readonly ToastEntry[] = [];
let listeners: readonly Listener[] = [];
let nextId = 1;
const timers = new Map<number, ReturnType<typeof setTimeout>>();

function emit(): void {
	for (const listener of listeners) listener();
}

/**
 * useSyncExternalStore 的 getSnapshot。
 *
 * 必须返回稳定引用：只要没有增删，返回的必须是同一个数组对象。若每次调用都新建数组，
 * React 会判定 store 一直在变，进入无限重渲染（与 use-detection-cache 修过的循环同源）。
 */
export function getToastSnapshot(): readonly ToastEntry[] {
	return entries;
}

export function subscribeToasts(listener: Listener): () => void {
	listeners = [...listeners, listener];
	return () => {
		listeners = listeners.filter(item => item !== listener);
	};
}

function dismiss(id: number): void {
	const timer = timers.get(id);
	if (timer !== undefined) {
		clearTimeout(timer);
		timers.delete(id);
	}

	const next = entries.filter(entry => entry.id !== id);
	if (next.length === entries.length) return;
	entries = next;
	emit();
}

function push(type: ToastType, message: string, duration?: number): void {
	const id = nextId++;
	const entry: ToastEntry = {id, type, message};
	// 超出可见上限时丢最旧的一条，并清掉它的定时器，避免残留 handle。
	const kept = entries.length >= MAX_VISIBLE_TOASTS ? entries.slice(entries.length - MAX_VISIBLE_TOASTS + 1) : entries;
	for (const dropped of entries.filter(item => !kept.includes(item))) {
		const timer = timers.get(dropped.id);
		if (timer !== undefined) {
			clearTimeout(timer);
			timers.delete(dropped.id);
		}
	}

	entries = [...kept, entry];
	const timer = setTimeout(() => dismiss(id), duration ?? TOAST_DURATION[type]);
	// unref：避免仅剩 toast 定时器时阻塞进程退出（Bun/Node 均支持；浏览器 polyfill 无此方法）。
	timer.unref?.();
	timers.set(id, timer);
	emit();
}

export const toast = {
	success: (message: string, duration?: number) => push('success', message, duration),
	error: (message: string, duration?: number) => push('error', message, duration),
	warning: (message: string, duration?: number) => push('warning', message, duration),
	info: (message: string, duration?: number) => push('info', message, duration)
};

/** 清空所有 toast 与定时器；供测试与 renderer 销毁时复位。 */
export function resetToasts(): void {
	for (const timer of timers.values()) clearTimeout(timer);
	timers.clear();
	entries = [];
	emit();
}
