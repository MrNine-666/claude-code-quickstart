import React from 'react';
import {TextAttributes, type ScrollBoxRenderable, type SyntaxStyle} from '@opentui/core';
import {borderColors, colors} from '../../theme/index.js';
import {CodePreview, type CodePreviewFiletype} from '../code-preview.js';
import {TextareaEditor, type EditorFiletype, type TextEditorHandle} from '../editor/TextareaEditor.js';
import {ThemedScrollbox} from '../themed-scrollbox.js';
import {ViewHeader} from '../view-header.js';
import type {ManagedDocumentSaveResult} from './document-types.js';

export type DocumentFormViewProps = {
	readonly title: string;
	readonly subtitle: string;
	readonly headerRight?: React.ReactNode;
	readonly editorTitle: string;
	readonly editInitial: string;
	readonly editorActive: boolean;
	readonly editorIsJson?: boolean;
	readonly editorFiletype: EditorFiletype;
	readonly syntaxStyle?: SyntaxStyle | null;
	readonly textareaFocused: boolean;
	readonly showRecommendation: boolean;
	readonly recommendationFocused: boolean;
	readonly recommendationTitle: string;
	readonly recommendationContent: string;
	readonly recommendationFiletype: CodePreviewFiletype;
	readonly editorRef: React.RefObject<TextEditorHandle | null>;
	readonly recommendationScrollRef: React.RefObject<ScrollBoxRenderable | null>;
	readonly onContentChange: () => void;
	readonly onCycleFocus: () => void;
	readonly onSave: (content: string) => ManagedDocumentSaveResult;
	readonly onCancel: () => void;
};

export function DocumentFormView({
	title,
	subtitle,
	headerRight,
	editorTitle,
	editInitial,
	editorActive,
	editorIsJson,
	editorFiletype,
	syntaxStyle,
	textareaFocused,
	showRecommendation,
	recommendationFocused,
	recommendationTitle,
	recommendationContent,
	recommendationFiletype,
	editorRef,
	recommendationScrollRef,
	onContentChange,
	onCycleFocus,
	onSave,
	onCancel
}: DocumentFormViewProps) {
	const editor = (
		<TextareaEditor
			ref={editorRef}
			title={editorTitle}
			initialContent={editInitial}
			active={editorActive}
			isJson={editorIsJson}
			filetype={editorFiletype}
			syntaxStyle={syntaxStyle}
			tabMode={showRecommendation ? 'cycle-focus' : 'indent'}
			textareaFocused={textareaFocused}
			escapeMode="bubble"
			previewEnabled={false}
			onContentChange={onContentChange}
			onCycleFocus={onCycleFocus}
			onSave={onSave}
			onCancel={onCancel}
		/>
	);

	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title={title} subtitle={subtitle} right={headerRight} />
			<box flexDirection="row" flexGrow={1} minHeight={0} border={false} gap={1} marginTop={1}>
				{showRecommendation ? (
					<box key="recommend-panel" flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
						<text flexShrink={0} fg={colors.primary} attributes={TextAttributes.BOLD}>
							{recommendationTitle}
						</text>
						<box
							flexGrow={1}
							minWidth={0}
							minHeight={0}
							borderStyle="rounded"
							borderColor={recommendationFocused ? borderColors.active : borderColors.inactive}
						>
							<ThemedScrollbox ref={recommendationScrollRef} style={{flexGrow: 1, minWidth: 0, minHeight: 0}}>
								<CodePreview content={recommendationContent} filetype={recommendationFiletype} />
							</ThemedScrollbox>
						</box>
					</box>
				) : null}
				<box key="editor-panel" flexDirection="column" flexGrow={1} flexBasis={0} minWidth={0}>
					{editor}
				</box>
			</box>
		</box>
	);
}
