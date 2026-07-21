// 共享组件导出（OpenTUI 适配）

export {StatusDot, type StatusDotProps, type StatusDotKind} from './status-dot.js';
export {Checkbox, type CheckboxProps} from './checkbox.js';
export {ShortcutBar, shortcutBarRows, type ShortcutBarProps, type Shortcut} from './shortcut-bar.js';
export {Modal, type ModalProps, type ModalTone} from './modal.js';
export {
	Spinner,
	busyActionTitle,
	type BusyAction,
	type BusyOverlayState,
	type SpinnerProps
} from './spinner.js';
export {toast, ToastViewport, type ToastType, type ToastOptions} from './toast.js';
export {Card, type CardProps} from './card.js';
export {ActionHint, type ActionHintProps} from './action-hint.js';
export {ViewHeader, type ViewHeaderProps} from './view-header.js';
export {DataTable, type DataTableProps, type TableColumn} from './data-table.js';
export {ErrorPanel, type ErrorPanelProps} from './error-panel.js';
export {ScrollList, type ScrollListProps, type ScrollListItem} from './scroll-list.js';
export {ThemedScrollbox} from './themed-scrollbox.js';
export {DetailPanel, type DetailPanelProps, type DetailItem} from './detail-panel.js';
export {DetailScreen, type DetailScreenProps} from './detail-screen.js';
export {TextareaEditor, type TextareaEditorProps, type EditorFiletype, type TextEditorHandle} from './editor/TextareaEditor.js';
export {CodePreview, type CodePreviewProps, type CodePreviewFiletype} from './code-preview.js';
export {ListEmptyState, ListLoadingState} from './list-state.js';
export {SingleLineInput, normalizeSingleLineValue, singleLineInputKeyBindings, type SingleLineInputProps} from './single-line-input.js';

// Form 组件导出
export type {FormField, SelectOption, KeyValueEntry} from './form/field-types.js';
export {
	FormPanel,
	isEditableField,
	nextEditableIndex,
	firstEditableIndex,
	type FormPanelProps
} from './form/FormPanel.js';
export {TextField, type TextFieldProps} from './form/TextField.js';
export {SelectField, type SelectFieldProps} from './form/SelectField.js';
export {RadioField, type RadioFieldProps} from './form/RadioField.js';
export {KeyValueField, serializeEntries, parseEntries, type KeyValueFieldProps} from './form/KeyValueField.js';
