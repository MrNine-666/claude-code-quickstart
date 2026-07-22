import {bindExecSignal} from '../../core/exec.js';
import {transitionSkillTopology} from '../../services/skills-adoption.js';
import {
	cleanupConfirmedReplacementSnapshots,
	installSearchResultsToTargets,
	searchSkillCatalogue,
	uninstallSkillAllAgents,
	updateAllSkillsBothSides,
	updateSingleSkill
} from '../../services/skills-service.js';
import {createSkillsDetectionRunner, runSkillsDetection} from '../../services/view-detection.js';
import type {SkillsViewServices} from './skills-view-types.js';

export function createSkillsViewServices(): SkillsViewServices {
	return {
		searchSkills: query => searchSkillCatalogue(query),
		installBatchToTargets: (results, targets, onProgress, installed, signal) =>
			installSearchResultsToTargets(results, targets, onProgress, signal ? bindExecSignal(signal) : undefined, {installed}),
		finalizeReplacementSnapshots: (replacements, confirmedKeys) => cleanupConfirmedReplacementSnapshots(replacements, confirmedKeys),
		transitionTopology: (skill, target, onProgress, signal) =>
			transitionSkillTopology(skill, target, onProgress, signal ? bindExecSignal(signal) : undefined),
		updateBothSides: (onProgress, signal) => updateAllSkillsBothSides(onProgress, signal ? bindExecSignal(signal) : undefined),
		updateOne: (name, onProgress, signal) => updateSingleSkill(name, onProgress, signal ? bindExecSignal(signal) : undefined),
		uninstallAllAgents: (name, onProgress, signal) =>
			uninstallSkillAllAgents(name, onProgress, signal ? bindExecSignal(signal) : undefined),
		createDetectionRunner: onChange => createSkillsDetectionRunner(onChange),
		runDetection: runner => runSkillsDetection(runner)
	};
}
