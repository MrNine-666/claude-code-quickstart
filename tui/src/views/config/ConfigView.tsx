import React, {useMemo} from 'react';
import type {SyntaxStyle} from '@opentui/core';
import {ManagedDocumentView} from '../../components/managed-document/ManagedDocumentView.js';
import {createConfigDocumentAdapter} from './config-document-adapter.js';
import type {AgentContext} from '../../state/manage-state.js';

export type ConfigViewProps = {
	readonly agentContext: AgentContext;
	readonly active: boolean;
	readonly onSubModeChange?: (subMode: string) => void;
	readonly onExitToNav: () => void;
	readonly onExitToHeader?: () => void;
	readonly syntaxStyle?: SyntaxStyle | null;
};

export function ConfigView(props: ConfigViewProps) {
	const adapter = useMemo(() => createConfigDocumentAdapter(props.agentContext), [props.agentContext]);
	return <ManagedDocumentView {...props} adapter={adapter} />;
}
