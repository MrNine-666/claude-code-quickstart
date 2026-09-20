import {TextAttributes} from '@opentui/core';
import {Checkbox, ListLoadingState, ScrollList, ThemedScrollbox, type ScrollListItem} from '../../components/index.js';
import {FormControlFrame} from '../../components/form/FormControlFrame.js';
import {FormLabel} from '../../components/form/FormLabel.js';
import {borderColors, colors} from '../../theme/index.js';
import type {PiModelCandidate} from '../../core/pi-provider.js';
import type {PiCatalogSource} from '../../core/pi-model-catalog.js';
import {
	piModelRowSummary,
	piResolutionLabel,
	piSourceJsonPreview,
	piSourceSummary,
	type PiModelSelectionState
} from '../../state/pi-model-selection-state.js';

const MODEL_DISCOVERY_LIST_HEIGHT = 14;

export function filterPiCandidates(candidates: readonly PiModelCandidate[], query: string): readonly PiModelCandidate[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return candidates;
	return candidates.filter(candidate => candidate.id.toLowerCase().includes(normalizedQuery));
}

type PiModelSelectionPanelProps = {
	readonly state: PiModelSelectionState;
	readonly focused: boolean;
	readonly active: boolean;
	readonly listFocused: boolean;
	readonly inputFocused: boolean;
	readonly candidates: readonly PiModelCandidate[];
	readonly cursor: number;
	readonly onManualModelChange: (value: string) => void;
	readonly onManualModelSubmit: (value: unknown) => void;
	readonly onManualModelFocus: () => void;
};

/**
 * Pi 模型列表：每行一个模型 ID，行尾展示来源解析状态。二级来源选择的按键与渲染
 * 都由 PiSourceSelectionPanel 拥有；本面板只消费 state。
 */
export function PiModelSelectionPanel({
	state,
	focused,
	active,
	listFocused,
	inputFocused,
	candidates,
	cursor,
	onManualModelChange,
	onManualModelSubmit,
	onManualModelFocus
}: PiModelSelectionPanelProps) {
	const cursorId = candidates[cursor]?.id;
	const items: ScrollListItem[] = candidates.map(candidate => {
		const label = piResolutionLabel(candidate);
		// 行尾只保留参数状态 + 来源状态，不展开具体值。
		const trailing = [piModelRowSummary(candidate), label].filter(Boolean).join(' · ');
		return {
			key: candidate.id,
			title: candidate.id,
			titleRight: trailing ? (
				<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					{trailing}
				</text>
			) : undefined,
			bordered: false,
			leading: <Checkbox checked={state.selected.has(candidate.id)} focused={listFocused && cursorId === candidate.id} />
		};
	});

	return (
		<box id="provider-model-selection" marginBottom={1} flexDirection="row" alignItems="flex-start" flexShrink={0}>
			<FormLabel label="模型列表" focused={focused} />
			<box flexDirection="column" flexGrow={1} minWidth={0} paddingX={1} borderStyle="rounded" borderColor={borderColors.active}>
				<box id="provider-model-input" flexDirection="row" alignItems="center" flexShrink={0}>
					<text
						fg={inputFocused ? colors.primary : colors.muted}
						attributes={inputFocused ? TextAttributes.BOLD : 0}
						selectionBg={colors.selectionBg}
						selectionFg={colors.selectionFg}
					>
						添加自定义模型
					</text>
					<FormControlFrame>
						{inputFocused ? (
							<input
								value={state.manualValue}
								placeholder="输入模型 ID，按 Enter 匹配来源"
								onInput={onManualModelChange}
								onSubmit={onManualModelSubmit}
								onMouseDown={onManualModelFocus}
								focused
								textColor={colors.inputFocusedText}
								cursorColor={colors.inputCursor}
								selectionBg={colors.selectionBg}
								selectionFg={colors.selectionFg}
							/>
						) : (
							<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
								{state.manualValue}
							</text>
						)}
					</FormControlFrame>
				</box>
				{state.warning ? (
					<box flexShrink={0} marginTop={1}>
						<text fg={colors.warning} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							{state.warning}
						</text>
					</box>
				) : null}
				<box id="provider-model-list" marginTop={1} height={MODEL_DISCOVERY_LIST_HEIGHT} minHeight={0} flexShrink={0}>
					{state.status === 'loading' ? (
						<ListLoadingState message="正在获取上游模型" />
					) : (
						<ScrollList
							items={items}
							cursor={cursor}
							active={active && listFocused}
							focusIndicator="card"
							emptyText={state.manualValue.trim() ? '没有匹配的模型' : '暂无模型，请获取上游模型或输入模型 ID'}
						/>
					)}
				</box>
			</box>
		</box>
	);
}

type PiSourceSelectionPanelProps = {
	readonly candidate: PiModelCandidate;
	readonly cursor: number;
	readonly view: 'summary' | 'json';
	readonly active: boolean;
};

/**
 * 二级来源选择：Tab 在摘要与最终 models.json 片段预览间切换；Enter 确认、Esc 返回由父级按键层处理。
 * 来源是单选，选中态直接用卡片的 active 高亮，不再叠加 ✅/⬜ 等多选框标记。
 * JSON 预览只为当前焦点候选按需生成。
 */
export function PiSourceSelectionPanel({candidate, cursor, view, active}: PiSourceSelectionPanelProps) {
	const sources = candidate.sources;
	const focusedSource: PiCatalogSource | null = sources[cursor] ?? null;
	const items: ScrollListItem[] = sources.map(source => ({
		key: source.key,
		title: `${source.provider} · ${source.api}`,
		body: (
			<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
				{piSourceSummary(source)}
			</text>
		),
		multiLine: true,
		bordered: false
	}));
	return (
		<box id="provider-model-source-selection" marginBottom={1} flexDirection="row" alignItems="flex-start" flexShrink={0}>
			<FormLabel label="来源选择" focused={active} />
			<box flexDirection="column" flexGrow={1} minWidth={0} paddingX={1} borderStyle="rounded" borderColor={borderColors.active}>
				<text
					fg={colors.primary}
					attributes={TextAttributes.BOLD}
					selectionBg={colors.selectionBg}
					selectionFg={colors.selectionFg}
				>
					{`为 ${candidate.id} 选择 Pi 官方来源`}
				</text>
				<box marginTop={1} height={MODEL_DISCOVERY_LIST_HEIGHT} minHeight={0} flexShrink={0}>
					{view === 'json' && focusedSource ? (
						<ThemedScrollbox style={{flexGrow: 1, minHeight: 0}} viewportCulling>
							<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
								{piSourceJsonPreview(candidate, focusedSource)}
							</text>
						</ThemedScrollbox>
					) : (
						<ScrollList
							items={items}
							cursor={cursor}
							active={active && sources.length > 0}
							focusIndicator="card"
							emptyText="没有可用的来源记录"
						/>
					)}
				</box>
				{candidate.relatedSources.length > 0 ? (
					<box flexShrink={0} marginTop={1}>
						<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
							{`其它 API 的同 ID 来源（只读，不可选）：${candidate.relatedSources
								.map(source => `${source.provider}/${source.api}`)
								.join('、')}`}
						</text>
					</box>
				) : null}
				<box flexShrink={0} marginTop={1}>
					<text fg={colors.muted} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						{`Tab 切换${view === 'summary' ? ' JSON 预览' : '摘要'} · Enter 确认来源 · Esc 返回（保持未勾选）`}
					</text>
				</box>
			</box>
		</box>
	);
}
