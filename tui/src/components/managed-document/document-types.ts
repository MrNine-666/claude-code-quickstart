import type {CodePreviewFiletype} from '../code-preview.js';
import type {EditorFiletype} from '../editor/TextareaEditor.js';

export type ManagedDocumentSnapshot = {
	readonly content: string;
	readonly hasContent: boolean;
	readonly previewContent: string;
};

export type ManagedDocumentSaveResult = {
	readonly ok: boolean;
	readonly error?: string;
	readonly warning?: string;
};

export type ManagedDocumentImportResult =
	| {readonly ok: true; readonly text: string; readonly message: string}
	| {readonly ok: false; readonly error: string};

export type ManagedDocumentAdapter = {
	readonly key: string;
	readonly title: string;
	readonly subtitle: string;
	readonly headerNotice?: string;
	readonly emptyMessage: string;
	readonly emptyHintLabel: string;
	readonly editorTitle: string;
	readonly recommendationTitle: string;
	readonly recommendationUnavailableMessage: string;
	readonly recommendationContent: string;
	readonly previewFiletype: CodePreviewFiletype;
	readonly recommendationFiletype: CodePreviewFiletype;
	readonly editorFiletype: EditorFiletype;
	readonly editorIsJson?: boolean;
	readonly saveSuccessMessage: string;
	readonly load: () => ManagedDocumentSnapshot;
	readonly createInitial: () => string;
	readonly importInto: (editorText: string) => ManagedDocumentImportResult;
	readonly save: (content: string) => ManagedDocumentSaveResult;
};
