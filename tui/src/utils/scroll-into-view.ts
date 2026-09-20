/** 目标元素在滚动容器里需要的最小几何信息。 */
type ScrollTarget = {
	readonly y: number;
	readonly height: number;
};

/** 可滚动容器的结构类型：viewport 使用屏幕坐标，target.y 同样为屏幕坐标。 */
export type ScrollableBox = {
	readonly viewport: {readonly y: number; readonly height: number};
	scrollBy(delta: {x: number; y: number}): void;
	findDescendantById?: (id: string) => ScrollTarget | null | undefined;
};

/**
 * 把滚动容器内的目标滚入可视区。
 *
 * 不使用 OpenTUI 的 `scrollChildIntoView`：它的 `getNearestDelta` 各分支都要求严格大于/
 * 小于，当目标高度**恰好等于**视口高度时三个分支都不命中并返回 0，表现为“切到该区域
 * 完全不滚动”。表单里的 Pi 模型列表正好是这种尺寸（height 14 vs 正常表单视口高度）。
 *
 * 这里的策略：目标高于等于视口时顶对齐（列表从头看起），否则保证目标完整可见
 * （优先下滚露出底部，其次上滚露出顶部）。
 */
export function scrollTargetIntoView(scrollbox: ScrollableBox, targetId: string): void {
	const target = scrollbox.findDescendantById?.(targetId);
	if (!target) return;
	const viewportTop = scrollbox.viewport.y;
	const viewportBottom = viewportTop + scrollbox.viewport.height;
	const targetTop = target.y;
	const targetBottom = target.y + target.height;

	if (target.height >= scrollbox.viewport.height) {
		if (targetTop !== viewportTop) scrollbox.scrollBy({x: 0, y: targetTop - viewportTop});
		return;
	}
	if (targetBottom > viewportBottom) {
		scrollbox.scrollBy({x: 0, y: targetBottom - viewportBottom});
		return;
	}
	if (targetTop < viewportTop) {
		scrollbox.scrollBy({x: 0, y: targetTop - viewportTop});
	}
}
