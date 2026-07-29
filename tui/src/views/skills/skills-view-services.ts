import {bindExecSignal} from '../../core/exec.js';
import {transitionSkillTopology} from '../../services/skills-adoption.js';
import {
	cleanupConfirmedReplacementSnapshots,
	installSearchResultsToTargets,
	searchSkillCatalogue,
	uninstallSkillInstances,
	updateSkillInstances
} from '../../services/skills-service.js';
import {createSkillsDetectionRunner, runSkillsDetection} from '../../services/view-detection.js';
import type {SkillsViewServices} from './skills-view-types.js';

export function createSkillsViewServices(): SkillsViewServices {
	return {
		searchSkills: query => searchSkillCatalogue(query),
		installBatchToTargets: (results, targets, onProgress, installed, signal) =>
			installSearchResultsToTargets(results, targets, onProgress, signal ? bindExecSignal(signal) : undefined, {
				...(installed ? {installed} : {})
			}),
		finalizeReplacementSnapshots: (replacements, confirmedKeys) => cleanupConfirmedReplacementSnapshots(replacements, confirmedKeys),
		transitionTopology: (item, target, onProgress, signal) =>
			transitionSkillTopology(item, target, onProgress, signal ? bindExecSignal(signal) : undefined),
		updateInstances: (items, onProgress, signal) =>
			updateSkillInstances(items, onProgress, signal ? bindExecSignal(signal) : undefined),
		uninstallInstances: (items, allItems, onProgress, signal) =>
			uninstallSkillInstances(items, allItems, onProgress, signal ? bindExecSignal(signal) : undefined),
		createDetectionRunner: onChange => createSkillsDetectionRunner(onChange),
		runDetection: runner => runSkillsDetection(runner)
	};
}
