import React, {useEffect, useRef, useState} from 'react';
import {TextAttributes, type ScrollBoxRenderable, type SyntaxStyle} from '@opentui/core';
import {useKeyboard} from '@opentui/react';
import {colors} from '../../theme/index.js';
import {isAppModifier, isEditingModifier} from '../../utils/keyboard.js';
import type {TextEditorHandle} from '../editor/TextareaEditor.js';
import {toast} from '../toast.js';
import {DocumentFormView} from './DocumentFormView.js';
import {DocumentHomeView} from './DocumentHomeView.js';
import type {ManagedDocumentAdapter, ManagedDocumentSnapshot} from './document-types.js';

type DocumentMode = 'view' | 'edit';
type DocumentPanel = 'editor' | 'split';
type DocumentFocus = 'editor' | 'recommend';

export type ManagedDocumentViewProps = {
	readonly adapter: ManagedDocumentAdapter;
	readonly active: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly onExitToHeader?: () => void;
	readonly syntaxStyle?: SyntaxStyle | null;
};

export function ManagedDocumentView({
	adapter,
	active,
	onSubModeChange,
	onExitToNav,
	onExitToHeader,
	syntaxStyle = null
}: ManagedDocumentViewProps) {
	const [snapshot, setSnapshot] = useState<ManagedDocumentSnapshot>(() => adapter.load());
	const [mode, setMode] = useState<DocumentMode>('view');
	const [editInitial, setEditInitial] = useState('');
	const [panel, setPanel] = useState<DocumentPanel>('editor');
	const [focus, setFocus] = useState<DocumentFocus>('editor');
	const [dirty, setDirty] = useState(false);
	const editorRef = useRef<TextEditorHandle>(null);
	const viewScrollRef = useRef<ScrollBoxRenderable>(null);
	const recommendationScrollRef = useRef<ScrollBoxRenderable>(null);

	const recommendationAvailable = adapter.recommendationContent !== '';
	const subMode =
		mode === 'view'
			? snapshot.hasContent
				? 'view-render'
				: 'view-empty'
			: panel === 'split'
				? focus === 'recommend'
					? 'edit-split-recommend'
					: 'edit-split-editor'
				: 'edit';

	function reset(nextSnapshot: ManagedDocumentSnapshot): void {
		setSnapshot(nextSnapshot);
		setEditInitial('');
		setMode('view');
		setPanel('editor');
		setFocus('editor');
		setDirty(false);
	}

	useEffect(() => {
		reset(adapter.load());
	}, [adapter]);

	useEffect(() => {
		if (active) {
			onSubModeChange?.(subMode);
		}
	}, [active, subMode, onSubModeChange]);

	function refreshView(): void {
		setSnapshot(adapter.load());
	}

	function enterEdit(): void {
		setEditInitial(adapter.createInitial());
		setDirty(false);
		setPanel('editor');
		setFocus('editor');
		setMode('edit');
	}

	function togglePanel(): void {
		if (panel === 'editor') {
			if (!recommendationAvailable) {
				toast.error(adapter.recommendationUnavailableMessage);
				return;
			}

			setPanel('split');
			setFocus('recommend');
			return;
		}

		setPanel('editor');
		setFocus('editor');
	}

	function cycleFocus(): void {
		setFocus(current => (current === 'editor' ? 'recommend' : 'editor'));
	}

	function importRecommendation(): void {
		if (!recommendationAvailable) {
			toast.error(adapter.recommendationUnavailableMessage);
			return;
		}

		const result = adapter.importInto(editorRef.current?.getText() ?? '');
		if (!result.ok) {
			toast.error(result.error);
			return;
		}

		editorRef.current?.replaceText(result.text);
		setDirty(true);
		toast.success(result.message);
	}

	function handleSave(content: string) {
		const result = adapter.save(content);
		if (!result.ok) {
			return result;
		}

		setDirty(false);
		refreshView();
		toast.success(adapter.saveSuccessMessage);
		if (result.warning) {
			toast.info(result.warning);
		}
		setMode('view');
		setPanel('editor');
		setFocus('editor');
		return result;
	}

	function cancelEdit(): void {
		if (dirty) {
			toast.info('已放弃未保存的编辑');
		}
		refreshView();
		setMode('view');
		setPanel('editor');
		setFocus('editor');
		setDirty(false);
	}

	useKeyboard(keyEvent => {
		if (!active) {
			return;
		}

		const name = keyEvent.name;
		const appMod = isAppModifier(keyEvent);
		const editingMod = isEditingModifier(keyEvent);
		if (mode === 'view') {
			if (name === 'escape' || name === 'left' || name === 'arrowleft') {
				onExitToNav();
				return;
			}
			if ((name === 'e' && snapshot.hasContent) || (name === 'a' && !snapshot.hasContent)) {
				enterEdit();
				return;
			}
			if (name === 'up') {
				const atTop = (viewScrollRef.current?.scrollTop ?? 0) <= 0;
				if (atTop && onExitToHeader) {
					onExitToHeader();
					return;
				}
				viewScrollRef.current?.scrollBy(-1);
				return;
			}
			if (name === 'down') {
				viewScrollRef.current?.scrollBy(1);
			}
			return;
		}

		if (name === 'escape') {
			cancelEdit();
			return;
		}
		if (editingMod && name === 's' && panel === 'split' && focus === 'recommend') {
			handleSave(editorRef.current?.getText() ?? '');
			return;
		}
		if (appMod && name === 't') {
			togglePanel();
			return;
		}
		if (appMod && name === 'o') {
			importRecommendation();
			return;
		}
		if (panel === 'split' && focus === 'recommend') {
			if (name === 'up') {
				recommendationScrollRef.current?.scrollBy(-1);
				return;
			}
			if (name === 'down') {
				recommendationScrollRef.current?.scrollBy(1);
				return;
			}
			if (name === 'tab') {
				cycleFocus();
			}
		}
	});

	const headerRight = adapter.headerNotice ? (
		<text fg={colors.warning} attributes={TextAttributes.DIM}>
			{adapter.headerNotice}
		</text>
	) : undefined;

	if (mode === 'view') {
		return (
			<DocumentHomeView
				title={adapter.title}
				subtitle={adapter.subtitle}
				headerRight={headerRight}
				hasContent={snapshot.hasContent}
				previewContent={snapshot.previewContent}
				previewFiletype={adapter.previewFiletype}
				emptyMessage={adapter.emptyMessage}
				emptyHintLabel={adapter.emptyHintLabel}
				scrollRef={viewScrollRef}
			/>
		);
	}

	const showRecommendation = panel === 'split' && recommendationAvailable;
	return (
		<DocumentFormView
			title={adapter.title}
			subtitle={adapter.subtitle}
			headerRight={headerRight}
			editorTitle={adapter.editorTitle}
			editInitial={editInitial}
			editorActive={active && (panel === 'editor' || focus === 'editor')}
			editorIsJson={adapter.editorIsJson}
			editorFiletype={adapter.editorFiletype}
			syntaxStyle={syntaxStyle}
			textareaFocused={focus === 'editor'}
			showRecommendation={showRecommendation}
			recommendationFocused={focus === 'recommend'}
			recommendationTitle={adapter.recommendationTitle}
			recommendationContent={adapter.recommendationContent}
			recommendationFiletype={adapter.recommendationFiletype}
			editorRef={editorRef}
			recommendationScrollRef={recommendationScrollRef}
			onContentChange={() => setDirty(true)}
			onCycleFocus={cycleFocus}
			onSave={handleSave}
			onCancel={cancelEdit}
		/>
	);
}
