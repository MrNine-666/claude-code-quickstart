import {createPiModelCandidate, piModelDefinitionFor} from '../core/pi-provider.js';
import type {PiModelCandidate, PiModelDefinition} from '../core/pi-provider.js';
import type {PiCatalogSource} from '../core/pi-model-catalog.js';

/**
 * Pi 模型选择状态机：候选、勾选、来源解析与二级来源选择都是纯数据转换，
 * view 只消费这些 transition 的结果，不自己判定唯一/冲突/无来源。
 */

export type PiSelectionStatus = 'idle' | 'loading' | 'selecting' | 'manual';

export type PiSourceView = 'summary' | 'json';

export type PiSourceModeState = {
	readonly modelId: string;
	/** 当前焦点来源在 candidate.sources 中的下标。 */
	readonly cursor: number;
	readonly view: PiSourceView;
};

export type PiModelSelectionState = {
	readonly status: PiSelectionStatus;
	readonly candidates: readonly PiModelCandidate[];
	readonly selected: ReadonlySet<string>;
	readonly cursor: number;
	readonly manualValue: string;
	/** 二级来源选择 submode；非 null 时列表按键交给来源选择处理。 */
	readonly sourceMode: PiSourceModeState | null;
	/** 非阻塞的目录降级提示（例如 pi.dev 不可用）。 */
	readonly warning: string | null;
};

export function piModelSelectionFromValues(values: {
	readonly models: string;
	readonly modelDefinitions?: readonly PiModelDefinition[];
}): PiModelSelectionState {
	const definitions = new Map((values.modelDefinitions ?? []).map(model => [model.id, model]));
	const ids = [
		...new Set(
			values.models
				.split(/[\n,]/u)
				.map(id => id.trim())
				.filter(Boolean)
		)
	];
	const candidates = ids.map(id => createPiModelCandidate({id, existingDefinition: definitions.get(id) ?? null}));
	return {
		status: candidates.length > 0 ? 'selecting' : 'idle',
		candidates,
		selected: new Set(ids),
		cursor: 0,
		manualValue: '',
		sourceMode: null,
		warning: null
	};
}

export function piEmptySelection(): PiModelSelectionState {
	return piModelSelectionFromValues({models: ''});
}

/** 稳定顺序的已选模型 ID：按候选列表顺序，保证保存结果可预期。 */
export function piSelectedModelIds(state: PiModelSelectionState): readonly string[] {
	return state.candidates.filter(candidate => state.selected.has(candidate.id)).map(candidate => candidate.id);
}

export function piCandidateFor(state: PiModelSelectionState, id: string): PiModelCandidate | null {
	return state.candidates.find(candidate => candidate.id === id) ?? null;
}

export function piSourceModeSource(state: PiModelSelectionState): PiCatalogSource | null {
	const mode = state.sourceMode;
	if (!mode) return null;
	const candidate = piCandidateFor(state, mode.modelId);
	return candidate?.sources[mode.cursor] ?? null;
}

export function piSelectedDefinitions(state: PiModelSelectionState): readonly PiModelDefinition[] {
	return state.candidates.filter(candidate => state.selected.has(candidate.id)).map(candidate => piResolvedDefinition(candidate));
}

/**
 * Ctrl+S 防御性门禁：返回第一个已勾选但来源未解决的模型 ID。
 * conflict / matching 都是非法保存状态；idle（编辑态既有模型）与已解析来源允许保存。
 */
export function findPiSelectionBlocker(state: PiModelSelectionState): string | null {
	for (const candidate of state.candidates) {
		if (!state.selected.has(candidate.id)) continue;
		if (candidate.resolution.kind === 'conflict' || candidate.resolution.kind === 'matching') return candidate.id;
	}
	return null;
}

function updateCandidate(
	state: PiModelSelectionState,
	id: string,
	update: (candidate: PiModelCandidate) => PiModelCandidate
): PiModelSelectionState {
	return {...state, candidates: state.candidates.map(candidate => (candidate.id === id ? update(candidate) : candidate))};
}

export function beginPiCandidateMatch(state: PiModelSelectionState, id: string): PiModelSelectionState {
	return updateCandidate(state, id, candidate => ({...candidate, resolution: {kind: 'matching'}}));
}

/** 匹配结果落地：唯一来源/已选来源/仅上游直接勾选；多个来源进入二级选择且保持未勾选。 */
export function applyPiCandidateMatch(state: PiModelSelectionState, candidate: PiModelCandidate, warning?: string): PiModelSelectionState {
	// 服务层只回传目录上下文，本地已有用户定义必须继续作为更高优先级层保留。
	const current = piCandidateFor(state, candidate.id);
	const merged: PiModelCandidate =
		current?.existingDefinition && !candidate.existingDefinition
			? {...candidate, existingDefinition: current.existingDefinition}
			: candidate;
	const next = updateCandidate(state, candidate.id, () => merged);
	const resolution = merged.resolution;
	if (resolution.kind === 'conflict') {
		return {
			...next,
			// 新的匹配结果拥有 warning 生命周期：本次无 warning 时清除上一次的降级提示。
			warning: warning ?? null,
			sourceMode: {modelId: merged.id, cursor: 0, view: 'summary'}
		};
	}
	const selected = new Set(next.selected);
	if (resolution.kind !== 'idle') selected.add(merged.id);
	const closedSourceMode = next.sourceMode?.modelId === merged.id ? null : next.sourceMode;
	return {...next, selected, sourceMode: closedSourceMode, warning: warning ?? null};
}

/** 匹配失败（网络/超时）：回到 idle，保留候选，等待用户重试。 */
export function failPiCandidateMatch(state: PiModelSelectionState, id: string, error: string): PiModelSelectionState {
	return {
		...updateCandidate(state, id, candidate => ({...candidate, resolution: {kind: 'idle'}})),
		warning: error
	};
}

export function selectPiCandidate(state: PiModelSelectionState, id: string): PiModelSelectionState {
	const selected = new Set(state.selected);
	selected.add(id);
	return {...state, selected};
}

/** 取消勾选同时清除已解析来源：再次勾选必须重新查询官方目录，保证“换来源”路径始终可达。 */
export function deselectPiCandidate(state: PiModelSelectionState, id: string): PiModelSelectionState {
	const selected = new Set(state.selected);
	selected.delete(id);
	const sourceMode = state.sourceMode?.modelId === id ? null : state.sourceMode;
	return {...updateCandidate(state, id, candidate => ({...candidate, resolution: {kind: 'idle'}})), selected, sourceMode};
}

export function openPiSourceMode(state: PiModelSelectionState, id: string): PiModelSelectionState {
	const candidate = piCandidateFor(state, id);
	if (!candidate || candidate.sources.length === 0) return state;
	const chosen = candidate.resolution.kind === 'chosen' || candidate.resolution.kind === 'automatic' ? candidate.resolution.source : null;
	const cursor = chosen
		? Math.max(
				0,
				candidate.sources.findIndex(source => source.key === chosen.key)
			)
		: 0;
	return {...state, sourceMode: {modelId: id, cursor, view: 'summary'}};
}

export function cancelPiSourceMode(state: PiModelSelectionState): PiModelSelectionState {
	return state.sourceMode ? {...state, sourceMode: null} : state;
}

export function movePiSourceCursor(state: PiModelSelectionState, delta: number): PiModelSelectionState {
	const mode = state.sourceMode;
	if (!mode) return state;
	const candidate = piCandidateFor(state, mode.modelId);
	const count = candidate?.sources.length ?? 0;
	if (count === 0) return state;
	const cursor = Math.min(count - 1, Math.max(0, mode.cursor + delta));
	return {...state, sourceMode: {...mode, cursor}};
}

export function togglePiSourceView(state: PiModelSelectionState): PiModelSelectionState {
	const mode = state.sourceMode;
	if (!mode) return state;
	return {...state, sourceMode: {...mode, view: mode.view === 'summary' ? 'json' : 'summary'}};
}

/** Enter 确认来源：整条来源记录采用（thinkingLevelMap 与 compat 不跨来源拼接），随后勾选模型。 */
export function confirmPiSourceMode(state: PiModelSelectionState): PiModelSelectionState {
	const mode = state.sourceMode;
	if (!mode) return state;
	const candidate = piCandidateFor(state, mode.modelId);
	const source = candidate?.sources[mode.cursor];
	if (!candidate || !source) return state;
	const next = updateCandidate(state, candidate.id, item => ({...item, resolution: {kind: 'chosen', source}}));
	const selected = new Set(next.selected);
	selected.add(candidate.id);
	return {...next, selected, sourceMode: null};
}

export function setPiManualValue(state: PiModelSelectionState, value: string): PiModelSelectionState {
	return {...state, manualValue: value};
}

export function startPiSelectionLoading(state: PiModelSelectionState): PiModelSelectionState {
	return {...state, status: 'loading'};
}

export function failPiSelectionLoading(state: PiModelSelectionState): PiModelSelectionState {
	return {...state, status: 'manual'};
}

/** 上游发现结果：已有候选保留 resolution，仅更新 upstream definition 并合并新 ID。 */
export function applyPiDiscovery(
	state: PiModelSelectionState,
	discovered: readonly PiModelDefinition[],
	warning?: string
): PiModelSelectionState {
	const byId = new Map(state.candidates.map(candidate => [candidate.id, candidate]));
	for (const definition of discovered) {
		const current = byId.get(definition.id);
		byId.set(
			definition.id,
			current
				? {...current, upstreamDefinition: definition}
				: createPiModelCandidate({id: definition.id, upstreamDefinition: definition})
		);
	}
	const candidates = [...byId.values()].sort((left, right) => left.id.localeCompare(right.id));
	return {...state, status: 'selecting', candidates, warning: warning ?? state.warning};
}

export function addPiManualCandidate(
	state: PiModelSelectionState,
	id: string,
	existingDefinition: PiModelDefinition | null
): PiModelSelectionState {
	const trimmed = id.trim();
	if (!trimmed) return state;
	const current = state.candidates.find(candidate => candidate.id === trimmed);
	const candidates = current ? state.candidates : [...state.candidates, createPiModelCandidate({id: trimmed, existingDefinition})];
	return {
		status: 'selecting',
		candidates,
		selected: new Set(state.selected),
		cursor: candidates.findIndex(c => c.id === trimmed),
		manualValue: '',
		sourceMode: null,
		warning: null
	};
}

export function setPiSelectionCursor(state: PiModelSelectionState, cursor: number): PiModelSelectionState {
	const count = state.candidates.length;
	const next = count === 0 ? 0 : Math.min(count - 1, Math.max(0, cursor));
	return {...state, cursor: next};
}

export function movePiSelectionCursor(state: PiModelSelectionState, delta: number): PiModelSelectionState {
	return setPiSelectionCursor(state, state.cursor + delta);
}

function isObject(value: unknown): value is Record<string, unknown> {
	return typeof value === 'object' && value !== null && !Array.isArray(value);
}

function hasUpstreamFields(definition: PiModelDefinition): boolean {
	return Object.keys(definition).some(key => key !== 'id');
}

/** 已解析候选最终写入的完整定义（目录 < 上游 < 已有用户配置）。 */
export function piResolvedDefinition(candidate: PiModelCandidate): PiModelDefinition {
	const source = candidate.resolution.kind === 'automatic' || candidate.resolution.kind === 'chosen' ? candidate.resolution.source : null;
	return piModelDefinitionFor(candidate, source);
}

/** 候选列表行尾状态：已解析来源只显示 provider 名，其余用最短状态词。 */
export function piResolutionLabel(candidate: PiModelCandidate): string {
	switch (candidate.resolution.kind) {
		case 'automatic':
		case 'chosen':
			return candidate.resolution.source.provider;
		case 'conflict':
			return `多来源 ${candidate.sources.length}`;
		case 'matching':
			return '匹配中';
		case 'upstream-only':
			return hasUpstreamFields(candidate.upstreamDefinition) ? '仅上游' : '仅 ID';
		default:
			return '';
	}
}

/**
 * 模型列表行尾的参数状态：已有 `models.json` 定义（除 id 外还有其它字段）时显示一个状态词，
 * 不展开具体值，避免撑满整行。
 */
export function piModelRowSummary(candidate: PiModelCandidate): string {
	const definition = candidate.existingDefinition;
	if (!definition) return '';
	return Object.keys(definition).length > 1 ? '已配置模型参数' : '';
}

function numericText(value: unknown): string {
	return typeof value === 'number' && Number.isFinite(value) ? String(value) : '-';
}

/** 二级来源摘要：只读取该条来源记录自己的字段。 */
export function piSourceSummary(source: PiCatalogSource): string {
	const definition = source.definition;
	const input = Array.isArray(definition.input)
		? definition.input.filter((value): value is string => typeof value === 'string').join('/')
		: '';
	const cost = isObject(definition.cost) ? definition.cost : null;
	const costText = cost ? `in ${numericText(cost.input)} / out ${numericText(cost.output)}` : '';
	const thinkingLevels = isObject(definition.thinkingLevelMap) ? Object.keys(definition.thinkingLevelMap) : [];
	const thinking = thinkingLevels.length > 0 ? thinkingLevels.join('/') : definition.reasoning === true ? '默认' : '无';
	const parts = [
		`上下文 ${numericText(definition.contextWindow)}`,
		`输出 ${numericText(definition.maxTokens)}`,
		input ? `输入 ${input}` : '',
		costText,
		`思考 ${thinking}`
	];
	return parts.filter(Boolean).join(' · ');
}

/** 二级来源 JSON 预览：只为当前焦点候选按需构造，展示“确认后将写入”的内容。 */
export function piSourceJsonPreview(candidate: PiModelCandidate, source: PiCatalogSource): string {
	return JSON.stringify(piModelDefinitionFor(candidate, source), null, 2);
}
