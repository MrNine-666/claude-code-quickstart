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
	readonly title: (model: TModel) => string;
	readonly savedMessage: (model: TModel, values: TValues) => string;
	readonly valuesToRecord: (values: TValues) => Record<string, string>;
	readonly recordToValues: (record: Record<string, string>, fallback: TValues) => TValues;
	readonly buildText: (values: TValues) => string;
	readonly parseText: (baseValues: TValues, raw: string) => ProviderFormTextResult<TValues>;
	readonly makeProviderTypeInput: (providerType: string) => TInput;
	readonly makeSubmitInput: (model: TModel, record: Record<string, string>) => TInput;
	readonly isTextReadOnly?: (values: TValues) => boolean;
};
