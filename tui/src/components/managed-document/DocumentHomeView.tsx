import React from 'react';
import type {ScrollBoxRenderable} from '@opentui/core';
import {borderColors} from '../../theme/index.js';
import {CodePreview, type CodePreviewFiletype} from '../code-preview.js';
import {ListEmptyState} from '../list-state.js';
import {ThemedScrollbox} from '../themed-scrollbox.js';
import {ViewHeader} from '../view-header.js';

export type DocumentHomeViewProps = {
	readonly title: string;
	readonly subtitle: string;
	readonly headerRight?: React.ReactNode;
	readonly hasContent: boolean;
	readonly previewContent: string;
	readonly previewFiletype: CodePreviewFiletype;
	readonly emptyMessage: string;
	readonly emptyHintLabel: string;
	readonly scrollRef: React.RefObject<ScrollBoxRenderable | null>;
};

export function DocumentHomeView({
	title,
	subtitle,
	headerRight,
	hasContent,
	previewContent,
	previewFiletype,
	emptyMessage,
	emptyHintLabel,
	scrollRef
}: DocumentHomeViewProps) {
	return (
		<box flexDirection="column" flexGrow={1}>
			<ViewHeader title={title} subtitle={subtitle} right={headerRight} />
			{hasContent ? (
				<box flexGrow={1} flexDirection="column" borderStyle="single" borderColor={borderColors.active}>
					<ThemedScrollbox ref={scrollRef} style={{flexGrow: 1}}>
						<CodePreview content={previewContent} filetype={previewFiletype} />
					</ThemedScrollbox>
				</box>
			) : (
				<ListEmptyState message={emptyMessage} hint={{label: emptyHintLabel, enabled: true}} />
			)}
		</box>
	);
}
