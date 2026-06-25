import {
	searchSkillCatalogue,
	installSearchResult,
	updateAllSkills,
	uninstallSelected
} from '../services/skills-service.js';
import {createSkillsDetectionRunner, runSkillsDetection} from '../services/view-detection.js';
import type {SkillsViewServices} from './SkillsView.js';

// Skills 视图默认 service 装配：连接 core/service 真实实现。
// 测试与 fallback 可传入自定义实现替换（保持组件与具体 IO 解耦）。
export function createSkillsViewServices(): SkillsViewServices {
	return {
		searchSkills: query => searchSkillCatalogue(query),
		installResult: (result, onProgress) => installSearchResult(result, onProgress),
		updateAll: onProgress => updateAllSkills(onProgress),
		uninstall: (names, onProgress) => uninstallSelected(names, onProgress),
		createDetectionRunner: onChange => createSkillsDetectionRunner(onChange),
		runDetection: runner => runSkillsDetection(runner)
	};
}
