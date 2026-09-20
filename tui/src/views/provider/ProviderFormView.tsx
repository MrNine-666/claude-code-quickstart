import {useEffect, useRef, useState} from 'react';
import {TextAttributes, type KeyEvent, type ScrollBoxRenderable, type TextareaRenderable} from '@opentui/core';
import {useKeyboard, useRenderer} from '@opentui/react';
import {toast} from '../../components/toast.js';
import {FormPanel, firstEditableIndex, nextEditableIndex} from '../../components/form/FormPanel.js';
import {FormLabel} from '../../components/form/FormLabel.js';
import {Modal} from '../../components/modal.js';
import {ThemedScrollbox} from '../../components/themed-scrollbox.js';
import {handleTextareaEditKeys, handleTextareaIndentKey} from '../../components/editor/textarea-edit-keys.js';
import type {FormField} from '../../components/form/field-types.js';
import {borderColors, colors} from '../../theme/index.js';
import {scrollTargetIntoView} from '../../utils/scroll-into-view.js';
import type {ProviderFormAdapter, ProviderFormModelBase, ProviderFormSubmitResult} from '../../types/provider-form-adapter.js';
import {PROVIDER_COMMANDS, providerBindings} from '../../config/keybindings.js';
import {isEditingModifier, matchesKeyBinding} from '../../utils/keyboard.js';
import type {PiModelCandidate, PiModelDefinition} from '../../core/pi-provider.js';
import {headerPresetNeedsConfirm, headerPresetText, piHeaderPreset, resolveHeaderPresetSelection} from '../../core/pi-header-preset.js';
import {
	addPiManualCandidate,
	applyPiCandidateMatch,
	applyPiDiscovery,
	beginPiCandidateMatch,
	cancelPiSourceMode,
	confirmPiSourceMode,
	deselectPiCandidate,
	failPiCandidateMatch,
	failPiSelectionLoading,
	findPiSelectionBlocker,
	movePiSourceCursor,
	openPiSourceMode,
	piCandidateFor,
	piEmptySelection,
	piModelSelectionFromValues,
	piResolvedDefinition,
	selectPiCandidate,
	setPiManualValue,
	setPiSelectionCursor,
	startPiSelectionLoading,
	togglePiSourceView,
	type PiModelSelectionState
} from '../../state/pi-model-selection-state.js';
import {PiModelSelectionPanel, PiSourceSelectionPanel, filterPiCandidates} from './pi-model-selection-panel.js';

/** 上游发现候选：旧式纯 ID 或携带完整字段的 Pi 模型定义。 */
export type DiscoveryModelCandidate = string | PiModelDefinition;

/** 保存时交给 adapter 的已解析模型定义。 */
export type DiscoverySelectedModel = {
	readonly id: string;
	readonly definition: PiModelDefinition;
};

export type DiscoveryMatchOutcome =
	| {readonly ok: true; readonly candidate: PiModelCandidate; readonly warning?: string}
	| {readonly ok: false; readonly error: string};

/** 从字段列表派生初始实时值。 */
function deriveValues(fields: readonly FormField[]): Record<string, string> {
	const result: Record<string, string> = {};
	for (const field of fields) {
		if (field.type === 'key-value') {
			result[field.id] = field.entries.map(entry => `${entry.key}=${entry.value}`).join(',');
		} else {
			result[field.id] = field.value;
		}
	}

	return result;
}

const JSON_FIELD_ID = 'provider-form-textarea';

// textarea 固定高度（含边框）。刻意例外：供应商字段多，textarea 若参与外层 scrollbox 的 flex 分配
// 会被字段挤没；且滚动内容内的 textarea 必须有确定高度，否则 min-content 塌成 0。此处用静态常量
// （非动态算高），不违反本次「禁止 height 算式」的核心诉求；整体字段区 + textarea 仍同在一个
// scrollbox 内一起滚动。
// Pi 表单的请求头编辑区按普通字段行渲染（`label │ 编辑区`），见 adapter.textFieldRow。
// 编辑区不再独占整行高度，因此比原先的全宽方块调小。
const TEXTAREA_HEIGHT = 8;

function providerBinding(command: string): string | undefined {
	const binding = providerBindings.find(item => item.cmd === command);
	return binding && typeof binding.key === 'string' ? binding.key : undefined;
}

function matchesProviderCommand(keyEvent: KeyEvent, command: string): boolean {
	const binding = providerBinding(command);
	return binding ? matchesKeyBinding(keyEvent, binding) : false;
}

export type ProviderFormProps<TInput, TValues, TModel extends ProviderFormModelBase<TValues> = ProviderFormModelBase<TValues>> = {
	readonly model: TModel;
	readonly active: boolean;
	readonly onCancel: () => void;
	readonly onSaved: (message: string, warning?: string) => void;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly buildForm: (input: TInput) => TModel;
	readonly save: (input: TInput, values: TValues) => ProviderFormSubmitResult;
	readonly validate: (values: TValues) => string[];
	readonly adapter: ProviderFormAdapter<TInput, TValues, TModel>;
	/** Optional async upstream model discovery. `string` entries keep the legacy ID-only path. */
	readonly onDiscover?: (values: TValues, signal?: AbortSignal) => Promise<readonly DiscoveryModelCandidate[]>;
	readonly onApplyDiscovered?: (values: TValues, models: readonly DiscoverySelectedModel[]) => TValues;
	/** Pi-only: lazily resolve one candidate against the official Pi catalog (called on first selection intent). */
	readonly onMatchCandidate?: (values: TValues, candidate: PiModelDefinition, signal?: AbortSignal) => Promise<DiscoveryMatchOutcome>;
	/** CC/CX model fields use the candidate list as a single-select field. */
	readonly modelSelectFieldIds?: readonly string[];
};

type ModelSelectionState = {
	readonly candidates: readonly string[];
	readonly selected: ReadonlySet<string>;
	readonly cursor: number;
	readonly manualValue: string;
};

type ModelDiscoveryState = ModelSelectionState & {
	readonly status: 'idle' | 'loading' | 'selecting' | 'manual';
};

type ModelFocus = 'list' | 'manual' | null;

function normalizeModelIds(value: unknown): readonly string[] {
	if (typeof value !== 'string') return [];
	return [
		...new Set(
			value
				.split(/[\n,]/u)
				.map(model => model.trim())
				.filter(Boolean)
		)
	];
}

function isPiModelDefinition(value: unknown): value is PiModelDefinition {
	return typeof value === 'object' && value !== null && typeof (value as {readonly id?: unknown}).id === 'string';
}

/** 从共享表单草稿中提取 Pi 的 ID 集合与已解析定义快照。 */
function piFormValues(values: unknown): {readonly models: string; readonly modelDefinitions?: readonly PiModelDefinition[]} {
	const candidate = (values ?? {}) as {readonly models?: unknown; readonly modelDefinitions?: unknown};
	const definitions = Array.isArray(candidate.modelDefinitions)
		? candidate.modelDefinitions.filter((item): item is PiModelDefinition => isPiModelDefinition(item))
		: [];
	return {models: typeof candidate.models === 'string' ? candidate.models : '', modelDefinitions: definitions};
}

/** 上游发现结果归一化：`string` 保持旧式仅 ID 语义，对象保留完整定义字段。 */
function normalizeDiscoveryCandidates(candidates: readonly DiscoveryModelCandidate[]): readonly PiModelDefinition[] {
	const byId = new Map<string, PiModelDefinition>();
	for (const candidate of candidates) {
		if (typeof candidate === 'string') {
			const id = candidate.trim();
			if (id) byId.set(id, {id});
			continue;
		}
		if (!isPiModelDefinition(candidate)) continue;
		const id = candidate.id.trim();
		if (id) byId.set(id, {...candidate, id});
	}
	return [...byId.values()];
}

function filterModelCandidates(candidates: readonly string[], query: string): readonly string[] {
	const normalizedQuery = query.trim().toLowerCase();
	if (!normalizedQuery) return candidates;
	return candidates.filter(candidate => candidate.toLowerCase().includes(normalizedQuery));
}

function initialModelDiscoveryState(value: unknown): ModelDiscoveryState {
	const candidates = normalizeModelIds(value);
	return {
		status: candidates.length > 0 ? 'selecting' : 'idle',
		candidates,
		selected: new Set(candidates),
		cursor: 0,
		manualValue: ''
	};
}

/**
 * ProviderForm：供应商表单屏（add/edit 统一复用）
 * - 字段区用 ↑/↓ 移动焦点，radio/select 用 ←/→ 或 Tab 切选项
 * - textarea：中间行 ↑/↓ 换行，第一行 ↑ / 最后行 ↓ 切字段，Tab 缩进（2 空格）
 * - Claude 使用 settings-compatible JSON；Codex 通过 adapter 使用真实 profile TOML
 */
export function ProviderFormView<TInput, TValues, TModel extends ProviderFormModelBase<TValues> = ProviderFormModelBase<TValues>>({
	model,
	active,
	onCancel,
	onSaved,
	onSubModeChange,
	buildForm,
	save,
	validate,
	adapter,
	onDiscover,
	onApplyDiscovered,
	onMatchCandidate,
	modelSelectFieldIds = []
}: ProviderFormProps<TInput, TValues, TModel>) {
	const formAdapter = adapter;
	const piModelDiscovery = Boolean(onDiscover && onApplyDiscovered && onMatchCandidate);
	const [fields, setFields] = useState(model.fields);
	const discoverableModelFieldIds =
		modelSelectFieldIds.length > 0 ? modelSelectFieldIds : fields.filter(field => field.type === 'model-select').map(field => field.id);
	const singleModelSelect = Boolean(onDiscover && discoverableModelFieldIds.length > 0);
	const [values, setValues] = useState<Record<string, string>>(() => deriveValues(model.fields));
	const [focusedIndex, setFocusedIndex] = useState(() => firstEditableIndex(model.fields));
	const [errors, setErrors] = useState<string[]>([]);
	const [baseValues, setBaseValues] = useState<TValues>(model.values);
	const [text, setText] = useState(() => formAdapter.buildText(model.values));
	const textareaRef = useRef<TextareaRenderable>(null);
	const renderer = useRenderer();
	const scrollRef = useRef<ScrollBoxRenderable>(null);
	const lastProviderType = useRef<string | undefined>((model.values as {providerType?: string}).providerType);
	// 记录程序化 setText 的目标文本，避免 onContentChange 回声反向同步。
	const pendingTextareaSync = useRef<string | null>(null);
	const modelDiscoveryRequest = useRef(0);
	const discoveryInFlight = useRef(false);
	const discoveryAbort = useRef<AbortController | null>(null);
	const discoveryCacheKey = useRef<string | null>(null);
	// 初始化为挂载时的发现依赖键：只有 baseUrl / api / apiKey 变化才重置发现，
	// 请求头 textarea 每次输入都命中同一个键而提前返回（design.md §8.3）。
	const discoverySourceKey = useRef<string | null>(discoveryContextKey(model.values));
	const discoveryShortcutQueued = useRef(false);
	const [discovery, setDiscovery] = useState<ModelDiscoveryState>(() => initialModelDiscoveryState(undefined));
	const [piSelection, setPiSelection] = useState<PiModelSelectionState>(() =>
		piModelDiscovery ? piModelSelectionFromValues(piFormValues(model.values)) : piEmptySelection()
	);
	// 事件处理器需要最新状态但又不能重建闭包；此 ref 只作只读快照。
	const piSelectionRef = useRef(piSelection);
	piSelectionRef.current = piSelection;
	const piMatchRequest = useRef(0);
	const piMatchAbort = useRef<AbortController | null>(null);
	const [modelFocus, setModelFocus] = useState<ModelFocus>(null);
	// 请求头预设的待确认项：非 null 时确认弹窗独占按键，确认才覆盖编辑区。
	const [pendingPreset, setPendingPreset] = useState<string | null>(null);
	const [singleModelFocus, setSingleModelFocus] = useState<string | null>(null);
	const [singleModelCursor, setSingleModelCursor] = useState(0);
	const hasTextEditor = formAdapter.showTextEditor !== false;
	const filteredCandidates = filterModelCandidates(discovery.candidates, discovery.manualValue);
	const selectedModel = discovery.candidates[discovery.cursor];
	const filteredCursor = selectedModel ? Math.max(0, filteredCandidates.indexOf(selectedModel)) : 0;
	const piFilteredCandidates = filterPiCandidates(piSelection.candidates, piSelection.manualValue);
	const piCursorId = piSelection.candidates[piSelection.cursor]?.id;
	const piFilteredCursor = piCursorId
		? Math.max(
				0,
				piFilteredCandidates.findIndex(candidate => candidate.id === piCursorId)
			)
		: 0;
	const piSourceCandidate = piSelection.sourceMode ? piCandidateFor(piSelection, piSelection.sourceMode.modelId) : null;
	const singleModelCandidatesFor = (fieldId: string | null | undefined): readonly string[] =>
		fieldId ? filterModelCandidates(discovery.candidates, values[fieldId] ?? '') : [];
	const focusedSingleModelCandidates = singleModelCandidatesFor(singleModelFocus);

	useEffect(() => {
		if (!active || !onSubModeChange) return;
		const subMode =
			pendingPreset !== null
				? 'form-pi-header-confirm'
				: piModelDiscovery
					? piSelection.sourceMode
						? 'form-pi-source'
						: 'form-pi'
					: singleModelSelect
						? 'form-model'
						: 'form';
		onSubModeChange(subMode);
	}, [active, onSubModeChange, pendingPreset, piModelDiscovery, piSelection.sourceMode, singleModelSelect]);

	const textFocused = hasTextEditor && focusedIndex === fields.length;
	const fieldFocused = modelFocus === null && !textFocused;
	const focusedFieldId =
		modelFocus === 'list'
			? 'provider-model-list'
			: modelFocus === 'manual'
				? 'provider-model-input'
				: textFocused
					? JSON_FIELD_ID
					: `form-field-${focusedIndex}-${fields[focusedIndex]?.id ?? 'unknown'}`;

	function discoveryContextKey(valuesToInspect: TValues): string {
		const candidate = valuesToInspect as {readonly baseUrl?: unknown; readonly apiKey?: unknown; readonly api?: unknown};
		const baseUrl = typeof candidate.baseUrl === 'string' ? candidate.baseUrl.trim() : '';
		const api = typeof candidate.api === 'string' ? candidate.api.trim() : '';
		const apiKey = typeof candidate.apiKey === 'string' ? candidate.apiKey : '';
		let hash = 2166136261;
		for (const char of apiKey) {
			hash ^= char.codePointAt(0) ?? 0;
			hash = Math.imul(hash, 16777619);
		}
		const mode = piModelDiscovery ? 'pi' : singleModelSelect ? 'single' : 'none';
		return `${mode}\u0000${baseUrl}\u0000${api}\u0000${apiKey.length}:${hash >>> 0}`;
	}

	function resetDiscoveryForValues(nextValues: TValues): void {
		if (!onDiscover) return;
		const nextKey = discoveryContextKey(nextValues);
		if (discoverySourceKey.current === nextKey) {
			return;
		}
		discoverySourceKey.current = nextKey;
		discoveryCacheKey.current = null;
		modelDiscoveryRequest.current += 1;
		discoveryAbort.current?.abort();
		discoveryAbort.current = null;
		piMatchRequest.current += 1;
		piMatchAbort.current?.abort();
		piMatchAbort.current = null;
		if (piModelDiscovery) {
			// Base URL / API / API Key 变化都会重建上游候选，因而清除已解析的目录来源。
			setPiSelection(piModelSelectionFromValues(piFormValues(nextValues)));
		}
		// 变化会 abort 进行中的发现；共享 discovery 的 loading 门禁必须一起退出，
		// 否则 abort 后的早退分支会把 status 永久留在 loading，再次按键全被静默吞掉。
		setDiscovery(initialModelDiscoveryState(undefined));
		setSingleModelFocus(null);
		setSingleModelCursor(0);
	}

	useEffect(() => {
		if (!scrollRef.current) {
			return;
		}

		scrollTargetIntoView(scrollRef.current, focusedFieldId);
	}, [focusedFieldId]);

	useEffect(() => {
		if (!textareaRef.current) {
			return;
		}

		const currentText = textareaRef.current.plainText;
		if (currentText === text) {
			pendingTextareaSync.current = null;
			return;
		}

		// 字段变化推送新文本到 textarea：setText 会重置 buffer，适合程序化覆盖。
		// OpenTUI textarea 的 initialValue 只适合首次初始化，后续赋值不会替换已有编辑内容。
		pendingTextareaSync.current = text;
		textareaRef.current.setText(text);
	}, [text]);

	useEffect(() => {
		if (!singleModelSelect || singleModelFocus === null) return;
		const focusedId = fields[focusedIndex]?.id;
		if (!focusedId || !discoverableModelFieldIds.includes(focusedId)) {
			setSingleModelFocus(null);
		}
	}, [discoverableModelFieldIds, fields, focusedIndex, singleModelFocus, singleModelSelect]);

	useEffect(() => {
		if (model.mode === 'edit') {
			return;
		}

		const providerTypeValue = values.providerType;
		if (!providerTypeValue || providerTypeValue === lastProviderType.current) {
			return;
		}

		lastProviderType.current = providerTypeValue;
		const nextModel = buildForm(formAdapter.makeProviderTypeInput(providerTypeValue));
		const nextRecord = deriveValues(nextModel.fields);
		nextRecord.providerType = providerTypeValue;

		if (values.apiKey) {
			nextRecord.apiKey = values.apiKey;
		}

		const nextBase = formAdapter.recordToValues(nextRecord, nextModel.values);
		nextRecord.apiKey = formAdapter.valuesToRecord(nextBase).apiKey ?? '';
		setFields(nextModel.fields);
		setValues(nextRecord);
		setBaseValues(nextBase);
		setText(formAdapter.buildText(nextBase));
		setFocusedIndex(firstEditableIndex(nextModel.fields));
		setErrors([]);
		resetDiscoveryForValues(nextBase);
	}, [values.providerType, model.mode, buildForm, formAdapter]);

	const handleMoveFocus = (direction: 1 | -1) => {
		if (piModelDiscovery) {
			const lastFieldIndex = nextEditableIndex(fields, fields.length, -1);
			// 请求头编辑区：面板把「添加自定义模型」渲染在列表上方，所以视觉上它下面是手动输入，
			// 因此 ↓ 进手动输入、↑ 回最后一个字段。必须同时把 focusedIndex 移出 fields.length，
			// 否则 textFocused 仍为真，textarea 会与模型区抢焦点。
			if (textFocused) {
				setFocusedIndex(lastFieldIndex);
				if (direction > 0) setModelFocus('manual');
				return;
			}

			if (modelFocus === 'list') {
				if (direction > 0) {
					const nextModel = piFilteredCandidates[piFilteredCursor + 1];
					if (nextModel) {
						setPiSelection(current =>
							setPiSelectionCursor(
								current,
								current.candidates.findIndex(candidate => candidate.id === nextModel.id)
							)
						);
					} else {
						// 列表末行是视觉序列的末端：↓ 环绕回表单第一个字段。
						setModelFocus(null);
						setFocusedIndex(firstEditableIndex(fields));
					}
				} else {
					const previousModel = piFilteredCandidates[piFilteredCursor - 1];
					if (!previousModel) {
						// 列表首行 ↑ 回上方的「添加自定义模型」。
						setModelFocus('manual');
						return;
					}
					setPiSelection(current =>
						setPiSelectionCursor(
							current,
							current.candidates.findIndex(candidate => candidate.id === previousModel.id)
						)
					);
				}
				return;
			}

			if (modelFocus === 'manual') {
				if (direction < 0) {
					// ↑ 回上方的请求头编辑区。
					setModelFocus(null);
					setFocusedIndex(fields.length);
				} else {
					// ↓ 进下方的模型列表；列表为空时它会立即把焦点交回第一个字段。
					setModelFocus('list');
				}
				return;
			}

			const next = nextEditableIndex(fields, focusedIndex, direction);
			if (direction > 0 && next <= focusedIndex) {
				// 最后一个字段 ↓ 进请求头编辑区。
				setFocusedIndex(fields.length);
				return;
			}
			if (direction < 0 && next >= focusedIndex) {
				// 第一个字段 ↑ 环绕到视觉序列末端：有候选时进模型列表并落在末行，否则到手动输入。
				if (piSelection.candidates.length > 0 || piSelection.status === 'loading') {
					setPiSelection(current => setPiSelectionCursor(current, Math.max(0, current.candidates.length - 1)));
					setModelFocus('list');
				} else setModelFocus('manual');
				return;
			}
			setFocusedIndex(next);
			return;
		}

		setFocusedIndex(current => {
			if (hasTextEditor && current === fields.length) {
				// textarea（虚拟 fields.length）按 ↑ 应切到紧邻的上一真实字段（末位可编辑）。
				return direction > 0 ? firstEditableIndex(fields) : nextEditableIndex(fields, fields.length, -1);
			}

			const next = nextEditableIndex(fields, current, direction);
			if (hasTextEditor && direction > 0 && next <= current) {
				return fields.length;
			}

			if (hasTextEditor && direction < 0 && next >= current) {
				return fields.length;
			}

			return next;
		});
	};

	const handleSelectChange = (id: string, direction: 1 | -1) => {
		const field = fields.find(item => item.id === id && (item.type === 'select' || item.type === 'radio'));
		if (!field || (field.type !== 'select' && field.type !== 'radio')) {
			return;
		}

		const currentValue = values[id] ?? field.value;
		const currentIndex = Math.max(
			0,
			field.options.findIndex(option => option.value === currentValue)
		);
		const nextIndex = (currentIndex + direction + field.options.length) % field.options.length;
		const nextOption = field.options[nextIndex];
		if (nextOption) {
			handleFieldChange(id, nextOption.value);
		}
	};

	const handleFieldChange = (id: string, value: string) => {
		const nextRecord = {...values, [id]: value};
		if (id === 'api') {
			// 协议切换后高亮项可能不在新的可用集内：回落到首个可用预设，
			// 否则 Enter 会应用动作行并未列出的预设（受控模式不得出现其它协议的预设）。
			nextRecord.headerPreset = resolveHeaderPresetSelection(value, nextRecord.headerPreset ?? '');
		}
		setValues(nextRecord);
		const nextFormValues = formAdapter.recordToValues(nextRecord, baseValues);
		setBaseValues(nextFormValues);
		if (formAdapter.syncFields) {
			setFields(currentFields => [...formAdapter.syncFields!(nextFormValues, currentFields)]);
		}
		if (id === 'headerPreset') {
			// 预设动作行只记录高亮：绝不触碰编辑区文本，也不触发发现重置（←/→ 不得改变请求头）。
			return;
		}
		setText(formAdapter.buildText(nextFormValues));
		setErrors([]);
		// 发现依赖键由 resetDiscoveryForValues 统一比较：只有 baseUrl / api / apiKey 变化才重置，
		// authHeader / headers 变化直接命中同一键提前返回。
		resetDiscoveryForValues(nextFormValues);
	};

	const handleSingleModelFocus = (fieldId: string) => {
		if (!singleModelSelect || !discoverableModelFieldIds.includes(fieldId) || discovery.candidates.length === 0) {
			return;
		}

		setSingleModelFocus(fieldId);
		const candidates = singleModelCandidatesFor(fieldId);
		setSingleModelCursor(current => Math.min(current, Math.max(0, candidates.length - 1)));
	};

	const handleSingleModelChange = (fieldId: string, value: string) => {
		handleFieldChange(fieldId, value);
		const candidates = filterModelCandidates(discovery.candidates, value);
		setSingleModelCursor(current => Math.min(current, Math.max(0, candidates.length - 1)));
	};

	const readCurrentValues = (): {readonly ok: true; readonly values: TValues} | {readonly ok: false; readonly error: string} => {
		if (!hasTextEditor) return {ok: true, values: baseValues};
		return formAdapter.parseText(baseValues, text);
	};

	const handleTextChange = (content: string) => {
		if (pendingTextareaSync.current === content) {
			pendingTextareaSync.current = null;
			return;
		}

		if (formAdapter.isTextReadOnly?.(baseValues)) {
			pendingTextareaSync.current = text;
			textareaRef.current?.setText(text);
			return;
		}

		setText(content);
		const parsed = formAdapter.parseText(baseValues, content);
		if (!parsed.ok) {
			setErrors([parsed.error]);
			return;
		}

		setErrors([]);
		setBaseValues(parsed.values);
		if (formAdapter.syncFields) {
			setFields(currentFields => [...formAdapter.syncFields!(parsed.values, currentFields)]);
		}
		setValues(prev => ({...prev, ...formAdapter.valuesToRecord(parsed.values)}));
		resetDiscoveryForValues(parsed.values);
	};

	/** 应用预设 = 把预设文本写进编辑区，复用既有文本同步链（含 pendingTextareaSync 回声防护）。 */
	const applyHeaderPresetText = (presetKey: string) => {
		const presetText = headerPresetText(presetKey);
		if (presetText === null) return;
		handleTextChange(presetText);
	};

	const handleManualModelChange = (value: string) => {
		if (piModelDiscovery) {
			setPiSelection(current => setPiManualValue(current, value));
			return;
		}
		setDiscovery(current => {
			const nextCandidates = filterModelCandidates(current.candidates, value);
			const currentModel = current.candidates[current.cursor];
			const nextModel = currentModel && nextCandidates.includes(currentModel) ? currentModel : nextCandidates[0];
			return {
				...current,
				manualValue: value,
				cursor: nextModel ? current.candidates.indexOf(nextModel) : 0
			};
		});
	};

	// textarea 键位（onKeyDown，handleKeyPress 之前）：Tab 缩进 + 边界 ↑/↓ 切字段。
	// onKeyDown 仅在 textarea focused（active && textFocused）时触发，无需再判 active/textFocused。
	const handleTextareaKey = (keyEvent: KeyEvent) => {
		if (handleTextareaIndentKey(keyEvent, textareaRef.current)) {
			return;
		}

		const ta = textareaRef.current;
		if (!ta) {
			return;
		}

		const name = keyEvent.name.toLowerCase();
		const line = ta.logicalCursor?.row ?? 0;
		const last = Math.max(0, (ta.lineCount ?? 1) - 1);
		if ((name === 'up' || name === 'arrowup') && line <= 0) {
			keyEvent.preventDefault();
			handleMoveFocus(-1);
			return;
		}
		if ((name === 'down' || name === 'arrowdown') && line >= last) {
			keyEvent.preventDefault();
			handleMoveFocus(1);
		}
	};

	const piSelectionForSubmit = (): readonly DiscoverySelectedModel[] =>
		piSelectionRef.current.candidates
			.filter(candidate => piSelectionRef.current.selected.has(candidate.id))
			.map(candidate => ({id: candidate.id, definition: piResolvedDefinition(candidate)}));

	/** 首次选择 intent 时才请求 Pi 官方目录；唯一/多来源/无来源均由 core 判定。 */
	const beginPiSelectionMatch = async (id: string, upstreamDefinition?: PiModelDefinition) => {
		if (!onMatchCandidate) return;
		const candidate = piCandidateFor(piSelectionRef.current, id);
		const definition = upstreamDefinition ?? candidate?.upstreamDefinition ?? {id};
		const parsed = readCurrentValues();
		if (!parsed.ok) {
			toast.error(parsed.error);
			return;
		}
		const requestId = ++piMatchRequest.current;
		const controller = new AbortController();
		piMatchAbort.current?.abort();
		piMatchAbort.current = controller;
		setPiSelection(current => beginPiCandidateMatch(current, id));
		try {
			const outcome = await onMatchCandidate(parsed.values, definition, controller.signal);
			if (requestId !== piMatchRequest.current) return;
			if (!outcome.ok) {
				setPiSelection(current => failPiCandidateMatch(current, id, outcome.error));
				toast.error(outcome.error);
				return;
			}
			setPiSelection(current => applyPiCandidateMatch(current, outcome.candidate, outcome.warning));
			if (outcome.warning) toast.warning(outcome.warning);
		} catch (error) {
			if (requestId !== piMatchRequest.current) return;
			const message = error instanceof Error ? error.message : String(error);
			setPiSelection(current => failPiCandidateMatch(current, id, message));
			toast.error(message || '模型来源匹配失败');
		} finally {
			if (piMatchAbort.current === controller) piMatchAbort.current = null;
		}
	};

	const handlePiSelectionIntent = (id: string, intent: 'toggle' | 'confirm') => {
		const state = piSelectionRef.current;
		const candidate = piCandidateFor(state, id);
		if (!candidate) return;
		if (state.selected.has(id)) {
			if (intent === 'confirm') {
				if (candidate.sources.length > 0) setPiSelection(current => openPiSourceMode(current, id));
				else toast.info('该模型没有可选的 Pi 官方目录来源');
			} else {
				setPiSelection(current => deselectPiCandidate(current, id));
			}
			return;
		}
		const resolution = candidate.resolution;
		if (resolution.kind === 'conflict') {
			setPiSelection(current => openPiSourceMode(current, id));
			return;
		}
		if (resolution.kind === 'matching') return;
		if (resolution.kind === 'automatic' || resolution.kind === 'chosen' || resolution.kind === 'upstream-only') {
			if (resolution.kind === 'upstream-only') toast.warning(`模型 ${id} 没有 Pi 官方目录匹配，将以仅上游/仅 ID 保存`);
			setPiSelection(current => selectPiCandidate(current, id));
			return;
		}
		void beginPiSelectionMatch(id);
	};

	const handleDiscover = async (requestedFieldId?: string, forceRefresh = false) => {
		if (!onDiscover || discoveryInFlight.current || discovery.status === 'loading' || piSelectionRef.current.status === 'loading')
			return;
		const focusedModelFieldId = fields[focusedIndex]?.id;
		const targetFieldId = requestedFieldId ?? focusedModelFieldId;
		const singleModelTargetFieldId = targetFieldId && discoverableModelFieldIds.includes(targetFieldId) ? targetFieldId : undefined;
		const parsed = readCurrentValues();
		if (!parsed.ok) {
			toast.error(parsed.error);
			return;
		}
		const baseUrl = (parsed.values as {readonly baseUrl?: unknown}).baseUrl;
		if (typeof baseUrl !== 'string' || baseUrl.trim() === '') {
			toast.warning('请先填写 Base URL，再获取上游模型');
			const baseUrlIndex = fields.findIndex(field => field.id === 'baseUrl');
			if (baseUrlIndex >= 0) {
				setModelFocus(null);
				setSingleModelFocus(null);
				setFocusedIndex(baseUrlIndex);
			}
			return;
		}
		const contextKey = discoveryContextKey(parsed.values);
		discoverySourceKey.current = contextKey;
		if (singleModelSelect && !forceRefresh && discoveryCacheKey.current === contextKey && discovery.candidates.length > 0) {
			setSingleModelFocus(singleModelTargetFieldId ?? null);
			const visibleCandidates = singleModelCandidatesFor(singleModelTargetFieldId);
			setSingleModelCursor(current => Math.min(current, Math.max(0, visibleCandidates.length - 1)));
			toast.info(`已加载 ${discovery.candidates.length} 个上游模型`);
			return;
		}
		const previous: ModelSelectionState = {
			candidates: discovery.candidates,
			selected: new Set(discovery.selected),
			cursor: discovery.cursor,
			manualValue: discovery.manualValue
		};
		const requestId = ++modelDiscoveryRequest.current;
		const controller = new AbortController();
		discoveryAbort.current = controller;
		discoveryInFlight.current = true;
		setErrors([]);
		setDiscovery({status: 'loading', ...previous});
		if (piModelDiscovery) setPiSelection(current => startPiSelectionLoading(current));
		if (singleModelSelect) setSingleModelFocus(singleModelTargetFieldId ?? null);
		else setModelFocus('list');
		// Pi 的候选与来源状态由 piSelection 拥有，共享 discovery.status 只是表单的加载门禁。
		// Pi 分支的三个出口（成功/空结果/异常）都必须复位它：否则 discovery.status 永久停在
		// loading，handleModelFocusKey 会静默吞掉 Space/Enter，重新获取上游模型也会被
		// 重入守卫挡成 no-op。
		const finishPiLoading = () => setDiscovery(current => ({...current, status: 'idle'}));
		try {
			const candidates = normalizeDiscoveryCandidates(await onDiscover(parsed.values, controller.signal));
			if (requestId !== modelDiscoveryRequest.current) {
				discoveryInFlight.current = false;
				return;
			}
			if (candidates.length === 0) {
				discoveryInFlight.current = false;
				if (piModelDiscovery) {
					finishPiLoading();
					setPiSelection(current => failPiSelectionLoading(current));
					setModelFocus('manual');
				} else {
					setDiscovery({status: singleModelSelect ? 'idle' : 'manual', ...previous, manualValue: ''});
					if (singleModelSelect) setSingleModelFocus(singleModelTargetFieldId ?? null);
					else setModelFocus('manual');
				}
				toast.warning('上游未返回可用模型，请手工添加模型');
				return;
			}
			if (singleModelSelect) {
				const modelIds = candidates.map(candidate => candidate.id);
				discoveryInFlight.current = false;
				discoveryCacheKey.current = contextKey;
				setDiscovery({
					status: 'selecting',
					candidates: modelIds,
					selected: new Set(modelIds),
					cursor: Math.min(singleModelCursor, Math.max(0, modelIds.length - 1)),
					manualValue: ''
				});
				setSingleModelFocus(singleModelTargetFieldId ?? null);
				const visibleCandidates = singleModelTargetFieldId
					? filterModelCandidates(modelIds, values[singleModelTargetFieldId] ?? '')
					: [];
				setSingleModelCursor(current => Math.min(current, Math.max(0, visibleCandidates.length - 1)));
				toast.success(`已获取 ${candidates.length} 个上游模型`);
				return;
			}
			discoveryInFlight.current = false;
			discoveryCacheKey.current = contextKey;
			finishPiLoading();
			setPiSelection(current => applyPiDiscovery(current, candidates));
			setModelFocus('list');
			toast.success(`已获取 ${candidates.length} 个上游模型`);
		} catch (error) {
			if (requestId !== modelDiscoveryRequest.current) {
				discoveryInFlight.current = false;
				return;
			}
			discoveryInFlight.current = false;
			const reason = error instanceof Error ? error.message : String(error);
			if (piModelDiscovery) {
				finishPiLoading();
				setPiSelection(current => failPiSelectionLoading(current));
				setModelFocus('manual');
			} else {
				setDiscovery({status: singleModelSelect ? 'idle' : 'manual', ...previous, manualValue: ''});
				if (singleModelSelect) setSingleModelFocus(singleModelTargetFieldId ?? null);
				else setModelFocus('manual');
			}
			toast.error(reason || '模型发现失败');
		} finally {
			if (discoveryAbort.current === controller) discoveryAbort.current = null;
		}
	};

	const triggerDiscover = (requestedFieldId?: string, forceRefresh = false) => {
		if (discoveryShortcutQueued.current) return;
		discoveryShortcutQueued.current = true;
		const request = handleDiscover(requestedFieldId, forceRefresh);
		queueMicrotask(() => {
			discoveryShortcutQueued.current = false;
		});
		void request;
	};

	const addManualModel = (rawValue?: string) => {
		if (piModelDiscovery) {
			if (piSelectionRef.current.status === 'loading') return;
			const model = (rawValue ?? piSelectionRef.current.manualValue).trim();
			if (!model) {
				toast.warning('模型不能为空');
				return;
			}
			setErrors([]);
			setPiSelection(current => addPiManualCandidate(current, model, null));
			setModelFocus('list');
			// 手工输入与上游发现走同一套惰性匹配入口。
			void beginPiSelectionMatch(model, {id: model});
			return;
		}
		if (discovery.status === 'loading') return;
		const model = (rawValue ?? discovery.manualValue).trim();
		if (!model) {
			toast.warning('模型不能为空');
			return;
		}
		setErrors([]);
		setDiscovery(current => {
			const candidates = [...new Set([...current.candidates, model])];
			const selected = new Set(current.selected);
			selected.add(model);
			return {status: 'selecting', candidates, selected, cursor: candidates.indexOf(model), manualValue: ''};
		});
		setModelFocus('list');
		toast.success(`已添加模型：${model}`);
	};

	const handleManualModelSubmit = (value: unknown) => {
		addManualModel(typeof value === 'string' ? value : undefined);
	};

	const handlePiSourceModeKey = (keyEvent: KeyEvent): boolean => {
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_CANCEL)) {
			keyEvent.preventDefault();
			setPiSelection(current => cancelPiSourceMode(current));
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_SOURCE_VIEW)) {
			keyEvent.preventDefault();
			setPiSelection(current => togglePiSourceView(current));
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_UP)) {
			keyEvent.preventDefault();
			setPiSelection(current => movePiSourceCursor(current, -1));
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DOWN)) {
			keyEvent.preventDefault();
			setPiSelection(current => movePiSourceCursor(current, 1));
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_CONFIRM)) {
			keyEvent.preventDefault();
			setPiSelection(current => confirmPiSourceMode(current));
			return true;
		}
		return true;
	};

	const handleModelFocusKey = (keyEvent: KeyEvent): boolean => {
		if (modelFocus === null) return false;
		if (piModelDiscovery && piSelectionRef.current.sourceMode) return handlePiSourceModeKey(keyEvent);
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_CANCEL)) {
			keyEvent.preventDefault();
			if (discovery.status === 'loading') modelDiscoveryRequest.current += 1;
			piMatchRequest.current += 1;
			piMatchAbort.current?.abort();
			discoveryAbort.current?.abort();
			onCancel();
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DISCOVER)) {
			keyEvent.preventDefault();
			triggerDiscover();
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_UP)) {
			keyEvent.preventDefault();
			handleMoveFocus(-1);
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DOWN)) {
			keyEvent.preventDefault();
			handleMoveFocus(1);
			return true;
		}
		if (discovery.status === 'loading' || piSelectionRef.current.status === 'loading') return true;
		if (modelFocus === 'manual') {
			// 字符输入与 Enter 提交由 OpenTUI input 自己处理，避免页面监听与 input submit 双触发。
			return false;
		}
		if (piModelDiscovery) {
			const focused = piFilteredCandidates[piFilteredCursor];
			if (!focused) return true;
			if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_MULTI_SELECT_TOGGLE)) {
				keyEvent.preventDefault();
				// 模型列表行只由 Space 承载选择：已勾选取消并清除来源，未勾选才获取来源并勾选。
				// Enter 落到分支末尾被消费为 no-op，避免泄漏到表单层触发保存/提交。
				handlePiSelectionIntent(focused.id, piSelectionRef.current.selected.has(focused.id) ? 'toggle' : 'confirm');
				return true;
			}
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_MULTI_SELECT_TOGGLE)) {
			keyEvent.preventDefault();
			const id = filteredCandidates[filteredCursor];
			if (id) {
				setDiscovery(current => {
					const selected = new Set(current.selected);
					if (selected.has(id)) selected.delete(id);
					else selected.add(id);
					return {...current, selected};
				});
			}
			return true;
		}
		return true;
	};

	const handleSingleModelSelect = (fieldId: string) => {
		if (!singleModelFocus || singleModelFocus !== fieldId || discovery.status === 'loading') return;
		const candidates = singleModelCandidatesFor(fieldId);
		const model = candidates[singleModelCursor];
		if (!model) return;
		handleFieldChange(fieldId, model);
		setSingleModelFocus(null);
	};

	const handleSingleModelSubmit = (fieldId: string) => {
		if (singleModelFocus !== fieldId) {
			handleSingleModelFocus(fieldId);
			return;
		}
		handleSingleModelSelect(fieldId);
	};

	const handleSingleModelKey = (keyEvent: KeyEvent): boolean => {
		if (singleModelFocus === null) return false;
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_CANCEL)) {
			keyEvent.preventDefault();
			if (discovery.status === 'loading') modelDiscoveryRequest.current += 1;
			discoveryAbort.current?.abort();
			discoveryInFlight.current = false;
			setSingleModelFocus(null);
			setDiscovery(current => ({...current, status: current.candidates.length > 0 ? 'selecting' : 'idle'}));
			return true;
		}
		if (discovery.status === 'loading') {
			const name = keyEvent.name.toLowerCase();
			return name === 'up' || name === 'arrowup' || name === 'down' || name === 'arrowdown';
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_UP)) {
			keyEvent.preventDefault();
			setSingleModelCursor(current => Math.max(0, current - 1));
			return true;
		}
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DOWN)) {
			keyEvent.preventDefault();
			const candidates = singleModelCandidatesFor(singleModelFocus);
			setSingleModelCursor(current => Math.min(Math.max(0, candidates.length - 1), current + 1));
			return true;
		}
		return false;
	};

	const handleFormKey = (keyEvent: KeyEvent): boolean => {
		// 保存快捷键由页面层独占（本组件的 useKeyboard 已处理 FORM_SAVE）。
		// 这里声明「已消费」，避免 FormPanel 的通用保存分支再调一次 onSubmit，
		// 导致重复落盘与重复保存 toast。MCP 表单没有自己的保存处理，仍由 FormPanel 负责。
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_SAVE)) return true;
		if (pendingPreset !== null) {
			// 确认弹窗打开时独占按键：Enter 覆盖、Esc 零改动，其余按键一律吞掉。
			if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_CONFIRM)) {
				keyEvent.preventDefault();
				applyHeaderPresetText(pendingPreset);
				setPendingPreset(null);
				return true;
			}
			if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_CANCEL)) {
				keyEvent.preventDefault();
				setPendingPreset(null);
				return true;
			}
			return true;
		}
		// 预设动作行：←/→ 只移动高亮（由 FormPanel 的 radio 分支处理），Enter 才应用。
		if (fields[focusedIndex]?.id === 'headerPreset' && matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_CONFIRM)) {
			keyEvent.preventDefault();
			const preset = piHeaderPreset(values.headerPreset ?? '');
			if (!preset) return true;
			if (headerPresetNeedsConfirm(text, preset.key)) setPendingPreset(preset.key);
			else applyHeaderPresetText(preset.key);
			return true;
		}
		if (singleModelSelect && onDiscover && matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DISCOVER)) {
			keyEvent.preventDefault();
			triggerDiscover(undefined, singleModelFocus !== null);
			return true;
		}
		if (singleModelFocus !== null) return handleSingleModelKey(keyEvent);
		if (!onDiscover || modelFocus !== null) return false;
		if (!singleModelSelect && !piModelDiscovery) return false;
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DISCOVER)) {
			keyEvent.preventDefault();
			triggerDiscover();
			return true;
		}
		return false;
	};

	useKeyboard(keyEvent => {
		if (!active) return;
		// 请求头预设确认弹窗打开时独占按键：一律交给 FormPanel 的 onKeyEvent（handleFormKey）处理，
		// 否则页面级的保存 / 发现快捷键会在弹窗期间泄漏，绕过二次确认。
		if (pendingPreset !== null) return;
		if (matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_SAVE)) {
			handleSubmit();
			return;
		}
		if (singleModelSelect && onDiscover && matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DISCOVER)) {
			keyEvent.preventDefault();
			triggerDiscover(undefined, singleModelFocus !== null);
			return;
		}
		if (modelFocus !== null) {
			handleModelFocusKey(keyEvent);
			return;
		}
		if (singleModelFocus !== null) return;
		if (onDiscover && matchesProviderCommand(keyEvent, PROVIDER_COMMANDS.FORM_DISCOVER)) {
			if (!piModelDiscovery) return;
			keyEvent.preventDefault();
			triggerDiscover();
			return;
		}
		if (!textFocused) return;

		const name = keyEvent.name.toLowerCase();
		if (formAdapter.isTextReadOnly?.(baseValues)) {
			if (name === 's' && isEditingModifier(keyEvent)) {
				handleSubmit();
				return;
			}
			if (name === 'escape') onCancel();
			return;
		}

		// 保存按编辑语义触发 · Ctrl+Z 撤销 · Ctrl+Shift+Z/Y 重做 · 复制按编辑语义触发选中（OSC52）。
		// undo/redo 后主动重新解析文本刷新错误（OpenTUI undo 走 FFI 不触发 onContentChange）。
		if (
			handleTextareaEditKeys(keyEvent, textareaRef.current, renderer, handleSubmit, () =>
				handleTextChange(textareaRef.current?.plainText ?? text)
			)
		) {
			return;
		}

		if (name === 'escape') onCancel();
	});

	const handleSubmit = () => {
		if (piModelDiscovery) {
			const blocker = findPiSelectionBlocker(piSelectionRef.current);
			if (blocker) {
				// 防御性门禁：已勾选但来源未解决的候选不得写入文件，先打开来源选择。
				toast.error(`模型 ${blocker} 的来源尚未确认，请先选择来源`);
				setPiSelection(current => openPiSourceMode(current, blocker));
				return;
			}
			if (piSelectionRef.current.status === 'loading') {
				toast.warning('正在获取上游模型，请稍候');
				return;
			}
		} else if (discovery.status === 'loading') {
			toast.warning('正在获取上游模型，请稍候');
			return;
		}

		const parsed = readCurrentValues();
		if (!parsed.ok) {
			setErrors([parsed.error]);
			return;
		}

		const selectedModels = piModelDiscovery ? piSelectionForSubmit() : [];
		const formValues = piModelDiscovery && onApplyDiscovered ? onApplyDiscovered(parsed.values, selectedModels) : parsed.values;
		const validationErrors = validate(formValues);
		if (validationErrors.length > 0) {
			setErrors(validationErrors);
			return;
		}

		const input = formAdapter.makeSubmitInput(model, values);
		const result = save(input, formValues);
		if (!result.ok) {
			if (result.errorKind === 'conflict') {
				setErrors([]);
				toast.error(result.error);
				return;
			}

			setErrors([result.error]);
			return;
		}

		onSaved(formAdapter.savedMessage(model, formValues), result.warning);
	};

	const title = formAdapter.title(model);
	const textLabel = typeof formAdapter.textLabel === 'function' ? formAdapter.textLabel(baseValues) : formAdapter.textLabel;
	const textHelpText = typeof formAdapter.textHelpText === 'function' ? formAdapter.textHelpText(baseValues) : formAdapter.textHelpText;
	const pendingPresetLabel = pendingPreset ? (piHeaderPreset(pendingPreset)?.label ?? pendingPreset) : '';
	// 请求头是普通字段：`textFieldRow` 的表单把编辑区渲染成 `label │ 编辑区` 一行（与其它字段对齐）；
	// CC/Codex 的 textarea 是整份文档编辑器（label 超出 FormLabel 固定宽度），保持全宽方块。
	const textareaControl = (
		<>
			{/* 刻意例外：本页字段区 + textarea 同在一个 scrollbox 内一起滚动（用户约束②），
			    且供应商字段多、textarea 若参与 flex 分配会被挤没（用户约束①），故 textarea
			    用静态常量高度 TEXTAREA_HEIGHT（非动态算高，不违反「禁止 height 算式」核心诉求）；
			    滚动内容内 textarea 必须有确定高度，否则会塌成 0 高。 */}
			<box
				height={TEXTAREA_HEIGHT}
				borderStyle="rounded"
				borderColor={textFocused ? borderColors.active : borderColors.inactive}
			>
				<textarea
					ref={textareaRef}
					initialValue={text}
					focused={active && textFocused}
					wrapMode="word"
					style={{flexGrow: 1}}
					textColor={colors.inputText}
					focusedTextColor={colors.inputFocusedText}
					cursorColor={colors.inputCursor}
					selectionBg={colors.selectionBg}
					selectionFg={colors.selectionFg}
					onKeyDown={handleTextareaKey}
					onContentChange={() => handleTextChange(textareaRef.current?.plainText ?? text)}
				/>
			</box>
			{textHelpText ? (
				<box marginTop={1}>
					<text
						fg={colors.muted}
						attributes={TextAttributes.DIM}
						selectionBg={colors.selectionBg}
						selectionFg={colors.selectionFg}
					>
						{textHelpText}
					</text>
				</box>
			) : null}
		</>
	);

	const textareaBlock = hasTextEditor ? (
		formAdapter.textFieldRow ? (
			<box id={JSON_FIELD_ID} flexDirection="row" alignItems="flex-start" flexShrink={0} marginBottom={1}>
				<FormLabel label={textLabel} focused={textFocused} />
				<box flexDirection="column" flexGrow={1} minWidth={0}>
					{textareaControl}
				</box>
			</box>
		) : (
			<box id={JSON_FIELD_ID} marginTop={1} flexDirection="column" flexShrink={0}>
				<text
					fg={textFocused ? colors.primary : colors.text}
					attributes={textFocused ? TextAttributes.BOLD : 0}
					selectionBg={colors.selectionBg}
					selectionFg={colors.selectionFg}
				>
					{textFocused ? '› ' : '  '}
					{textLabel}
				</text>
				{textareaControl}
			</box>
		)
	) : null;

	const pageCustom = piModelDiscovery ? (
		piSelection.sourceMode && piSourceCandidate ? (
			<PiSourceSelectionPanel
				candidate={piSourceCandidate}
				cursor={piSelection.sourceMode.cursor}
				view={piSelection.sourceMode.view}
				active={active && modelFocus !== null}
			/>
		) : (
			<PiModelSelectionPanel
				state={piSelection}
				focused={modelFocus !== null}
				active={active}
				listFocused={modelFocus === 'list'}
				inputFocused={modelFocus === 'manual'}
				candidates={piFilteredCandidates}
				cursor={piFilteredCursor}
				onManualModelChange={handleManualModelChange}
				onManualModelSubmit={handleManualModelSubmit}
				onManualModelFocus={() => setModelFocus('manual')}
			/>
		)
	) : null;

	return (
		<box flexDirection="column" flexGrow={1} minHeight={0}>
			<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1, minHeight: 0}} viewportCulling>
				<FormPanel
					title={title}
					fields={fields}
					values={values}
					focusedIndex={fieldFocused ? focusedIndex : -1}
					active={active && fieldFocused}
					errors={undefined}
					onMoveFocus={handleMoveFocus}
					onSelectChange={handleSelectChange}
					onFieldChange={handleFieldChange}
					onSubmit={handleSubmit}
					onCancel={onCancel}
					onKeyEvent={handleFormKey}
					modelSelect={
						singleModelSelect
							? {
									fieldIds: discoverableModelFieldIds,
									openFieldId: singleModelFocus,
									loading: discovery.status === 'loading',
									candidates: focusedSingleModelCandidates,
									cursor: singleModelCursor,
									onChange: handleSingleModelChange,
									onSubmit: handleSingleModelSubmit,
									onFocus: handleSingleModelFocus,
									onKeyDown: (_fieldId, keyEvent) => handleSingleModelKey(keyEvent)
								}
							: undefined
					}
					custom={
						<>
							{textareaBlock}
							{pageCustom}
						</>
					}
				/>
			</ThemedScrollbox>

			{errors.length > 0 ? (
				<box marginTop={1} flexShrink={0}>
					<text fg={colors.danger} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
						{errors.join('；')}
					</text>
				</box>
			) : null}

			<Modal
				active={pendingPreset !== null}
				title="覆盖请求头？"
				hint="Enter 确认 · Esc 取消"
				tone="warning"
			>
				<text fg={colors.text} selectionBg={colors.selectionBg} selectionFg={colors.selectionFg}>
					{`即将用「${pendingPresetLabel}」预设覆盖当前请求头。`}
				</text>
			</Modal>
		</box>
	);
}
