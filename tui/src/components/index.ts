// 共享组件导出（OpenTUI 适配）

export { StatusDot, type StatusDotProps, type StatusDotKind } from './status-dot.js';
export { Checkbox, type CheckboxProps } from './checkbox.js';
export { ShortcutBar, type ShortcutBarProps, type Shortcut } from './shortcut-bar.js';
export { ConfirmModal, type ConfirmModalProps } from './confirm-modal.js';
export { Spinner, type SpinnerProps } from './spinner.js';
export { toast, ToastViewport, type ToastType, type ToastOptions } from './toast.js';
export { StatusLabel, type StatusLabelProps, type StatusKind } from './status-label.js';
export { Card, type CardProps } from './card.js';
export { DataTable, type DataTableProps, type TableColumn } from './data-table.js';
export { ErrorPanel, type ErrorPanelProps } from './error-panel.js';
export { ScrollList, type ScrollListProps, type ScrollListItem } from './scroll-list.js';
export { DetailPanel, type DetailPanelProps, type DetailItem } from './detail-panel.js';
export { DetailScreen, type DetailScreenProps } from './detail-screen.js';
export { ProgressLog, type ProgressLogProps } from './progress-log.js';
export { TextareaEditor, type TextareaEditorProps, type EditorFiletype } from './editor/TextareaEditor.js';

// Form 组件导出
export type { FormField, SelectOption, KeyValueEntry } from './form/field-types.js';
export { FormPanel, isEditableField, nextEditableIndex, firstEditableIndex, type FormPanelProps } from './form/FormPanel.js';
export { TextField, type TextFieldProps } from './form/TextField.js';
export { SelectField, type SelectFieldProps } from './form/SelectField.js';
export { KeyValueField, serializeEntries, parseEntries, type KeyValueFieldProps } from './form/KeyValueField.js';
