import {describe, expect, test} from 'bun:test';
import {buildPiCatalogIndex} from '../../src/core/pi-model-catalog.js';
import {resolvePiModelCandidate} from '../../src/core/pi-provider.js';
import {
	applyPiCandidateMatch,
	applyPiDiscovery,
	beginPiCandidateMatch,
	deselectPiCandidate,
	openPiSourceMode,
	piCandidateFor,
	piEmptySelection,
	piSelectedModelIds
} from '../../src/state/pi-model-selection-state.js';

const catalogResult = buildPiCatalogIndex({
	openai: {
		'gpt-5': {id: 'gpt-5', api: 'openai-responses', provider: 'openai', contextWindow: 400000, maxTokens: 128000}
	}
});
if (!catalogResult.ok) throw new Error('catalog fixture must parse');
const catalog = catalogResult.index;

function matchedSelection(id: string, api: string) {
	const candidate = resolvePiModelCandidate({id, api, upstreamDefinition: {id}, catalog});
	return applyPiCandidateMatch(applyPiDiscovery(piEmptySelection(), [{id}]), candidate);
}

describe('deselectPiCandidate', () => {
	test('取消勾选必须清除已解析来源', () => {
		const state = matchedSelection('gpt-5', 'openai-responses');
		expect(piSelectedModelIds(state)).toEqual(['gpt-5']);
		expect(piCandidateFor(state, 'gpt-5')?.resolution.kind).toBe('automatic');

		const next = deselectPiCandidate(state, 'gpt-5');
		expect(piSelectedModelIds(next)).toEqual([]);
		expect(piCandidateFor(next, 'gpt-5')?.resolution).toEqual({kind: 'idle'});
	});

	test('取消勾选会关闭该候选的二级来源选择', () => {
		const opened = openPiSourceMode(matchedSelection('gpt-5', 'openai-responses'), 'gpt-5');
		expect(opened.sourceMode?.modelId).toBe('gpt-5');

		const next = deselectPiCandidate(opened, 'gpt-5');
		expect(next.sourceMode).toBeNull();
		expect(piCandidateFor(next, 'gpt-5')?.resolution).toEqual({kind: 'idle'});
	});

	test('取消后重新勾选必须重新匹配而不是复用旧来源', () => {
		const deselected = deselectPiCandidate(matchedSelection('gpt-5', 'openai-responses'), 'gpt-5');
		const matching = beginPiCandidateMatch(deselected, 'gpt-5');
		expect(piCandidateFor(matching, 'gpt-5')?.resolution).toEqual({kind: 'matching'});

		const rematched = applyPiCandidateMatch(
			matching,
			resolvePiModelCandidate({id: 'gpt-5', api: 'openai-responses', upstreamDefinition: {id: 'gpt-5'}, catalog})
		);
		expect(piCandidateFor(rematched, 'gpt-5')?.resolution.kind).toBe('automatic');
		expect(piSelectedModelIds(rematched)).toEqual(['gpt-5']);
	});
});
