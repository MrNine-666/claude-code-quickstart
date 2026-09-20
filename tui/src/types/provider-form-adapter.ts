import type {FormField} from '../components/form/field-types.js';

export type ProviderFormModelBase<TValues> = {
	readonly mode: string;
	readonly fields: readonly FormField[];
	readonly values: TValues;
};

export type ProviderFormTextResult<TValues> = {readonly ok: true; readonly values: TValues} | {readonly ok: false; readonly error: string};

export type ProviderFormSubmitResult =
	| {readonly ok: true; readonly data: unknown; readonly warning?: string}
	| {readonly ok: false; readonly error: string; readonly errorKind?: 'conflict'};

export type ProviderFormAdapter<TInput, TValues, TModel extends ProviderFormModelBase<TValues>> = {
	readonly textLabel: string | ((values: TValues) => string);
	/** 共享 textarea 下方的说明文案（例如 Pi 请求头的 JSON / $ENV 语义）。 */
	readonly textHelpText?: string | ((values: TValues) => string);
	readonly title: (model: TModel) => string;
	readonly savedMessage: (model: TModel, values: TValues) => string;
	readonly valuesToRecord: (values: TValues) => Record<string, string>;
	readonly recordToValues: (record: Record<string, string>, fallback: TValues) => TValues;
	readonly buildText: (values: TValues) => string;
	readonly parseText: (baseValues: TValues, raw: string) => ProviderFormTextResult<TValues>;
	/** Whether the shared form should expose the raw JSON/TOML editor. */
	readonly showTextEditor?: boolean;
	/**
	 * 把共享 textarea 渲染成普通字段行（`label │ 编辑区`）而不是全宽方块。
	 * Pi 的「请求头」是普通字段，与其它字段对齐更自然；CC/Codex 的 textarea 是整份文档编辑器，
	 * 且其 label 长度超过 `FormLabel` 的固定宽度会被截断，因此保持全宽方块。
	 */
	readonly textFieldRow?: boolean;
	/** Keep dynamic field projections (for example checkbox options) in sync with values. */
	readonly syncFields?: (values: TValues, fields: readonly FormField[]) => readonly FormField[];
	readonly makeProviderTypeInput: (providerType: string) => TInput;
	readonly makeSubmitInput: (model: TModel, record: Record<string, string>) => TInput;
	readonly isTextReadOnly?: (values: TValues) => boolean;
};
