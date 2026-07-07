import type {AgentContext} from '../state/manage-state.js';
import {
	installSearchResult,
	searchSkillCatalogue,
	uninstallSelected,
	updateAllSkills
} from '../services/skills-service.js';
import {createSkillsDetectionRunner, runSkillsDetection} from '../services/view-detection.js';
import type {SkillsViewServices} from './SkillsView.js';

// Skills 视图默认 service 装配：连接 service 真实实现。
// agentContext 决定 skills CLI 的 --agent 参数（claude-code / codex）；切换 Header 时
// App 重建 services，使检测与 install/update/uninstall 全部走当前 Agent。
// 测试与 fallback 可传入自定义实现替换（保持组件与具体 IO 解耦）。
export function createSkillsViewServices(agentContext: AgentContext = 'cc'): SkillsViewServices {
	return {
		searchSkills: query => searchSkillCatalogue(query),
		installResult: (result, onProgress, exec) => installSearchResult(result, onProgress, agentContext, exec),
		updateAll: (onProgress, exec) => updateAllSkills(onProgress, agentContext, exec),
		uninstall: (names, onProgress, exec) => uninstallSelected(names, onProgress, agentContext, exec),
		createDetectionRunner: onChange => createSkillsDetectionRunner(onChange),
		runDetection: runner => runSkillsDetection(runner, agentContext)
	};
}
