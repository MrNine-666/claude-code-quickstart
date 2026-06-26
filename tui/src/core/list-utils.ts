/**
 * 列表导航共享工具。
 */

/**
 * 列表游标循环移动：超出边界则循环到另一端（length 为 0 时返回 0）。
 * 统一 ProviderView / McpView 原本地重复的 clampMove 实现（DRY）。
 */
export function clampMove(prev: number, delta: number, length: number): number {
	if (length === 0) {
		return 0;
	}

	const next = prev + delta;
	if (next < 0) {
		return length - 1;
	}

	if (next >= length) {
		return 0;
	}

	return next;
}
