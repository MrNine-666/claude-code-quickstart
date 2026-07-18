import {
	cleanupConfirmedReplacementSnapshots,
	installSearchResultsToTargets,
	searchSkillCatalogue,
	uninstallSkillAllAgents,
	updateAllSkillsBothSides,
	updateSingleSkill
} from '../services/skills-service.js';
import {transitionSkillTopology} from '../services/skills-adoption.js';
import {createSkillsDetectionRunner, runSkillsDetection} from '../services/view-detection.js';
import type {SkillsViewServices} from './SkillsView.js';

// Skills 视图默认 service 装配（shared-resource-injection-ui Section 17-18）：连接双侧共享 service 实现。
// 检测走无 `--agent` 全量扫（一次 list 得双侧态），与 agentContext 解耦；install 目标由 Modal 显式选，
// 不再按 Header agentContext 建 service key。测试与 fallback 可传入自定义实现替换（组件与具体 IO 解耦）。
export function createSkillsViewServices(): SkillsViewServices {
	return {
		searchSkills: query => searchSkillCatalogue(query),
		installBatchToTargets: (results, targets, onProgress, installed) => installSearchResultsToTargets(
			results,
			targets,
			onProgress,
			undefined,
			{installed}
		),
		finalizeReplacementSnapshots: (replacements, confirmedKeys) => cleanupConfirmedReplacementSnapshots(replacements, confirmedKeys),
		transitionTopology: (skill, target, onProgress) => transitionSkillTopology(skill, target, onProgress),
		updateBothSides: onProgress => updateAllSkillsBothSides(onProgress),
		updateOne: (name, onProgress) => updateSingleSkill(name, onProgress),
		uninstallAllAgents: (name, onProgress) => uninstallSkillAllAgents(name, onProgress),
		createDetectionRunner: onChange => createSkillsDetectionRunner(onChange),
		// detection 走无 --agent 全量扫（一次 list 得双侧态），默认真实 exec。
		runDetection: runner => runSkillsDetection(runner)
	};
}
