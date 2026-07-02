// `ccq tools ...` — 非交互工具管理命令。

import {createConsoleProgress} from '../../core/exec.js';
import {detectComponents, updateComponents, uninstallComponent, type ComponentId, type ManagedComponent} from '../../core/tools-manage.js';
import {confirmDangerousAction} from '../confirm.js';

const TOOL_ALIASES: Record<string, ComponentId> = {
	claude: 'ClaudeCode',
	claudecode: 'ClaudeCode',
	'claude-code': 'ClaudeCode',
	ccline: 'Ccline',
	ccg: 'CcgWorkflow',
	ccgworkflow: 'CcgWorkflow',
	'ccg-workflow': 'CcgWorkflow',
	openspec: 'OpenSpec',
	'open-spec': 'OpenSpec',
	codegraph: 'CodeGraph',
	'code-graph': 'CodeGraph',
	codex: 'CodexCli',
	codexcli: 'CodexCli',
	'codex-cli': 'CodexCli',
	agy: 'AntigravityCli',
	antigravity: 'AntigravityCli',
	antigravitycli: 'AntigravityCli',
	'antigravity-cli': 'AntigravityCli'
};

export async function runTools(action: 'update' | 'uninstall', name: string | undefined, assumedYes: boolean): Promise<number> {
	switch (action) {
		case 'update':
			return runToolsUpdate(name);
		case 'uninstall':
			return runToolsUninstall(name, assumedYes);
	}
}

async function runToolsUpdate(name: string | undefined): Promise<number> {
	console.log('正在检测工具状态与可用更新...');
	const components = await detectComponents();
	const targets = selectUpdateTargets(components, name);
	if (!targets.ok) {
		console.error(targets.error);
		printAvailableTools(components);
		return 1;
	}

	if (targets.components.length === 0) {
		console.log(name ? '目标工具当前没有可用更新。' : '所有工具当前没有可用更新。');
		return 0;
	}

	const result = await updateComponents(targets.components, createConsoleProgress());
	console.log(`更新快照: ${result.snapshotPath}`);
	const failed = result.updatedItems.filter(item => item.startsWith('failed::'));
	return failed.length > 0 ? 1 : 0;
}

async function runToolsUninstall(name: string | undefined, assumedYes: boolean): Promise<number> {
	if (!name) {
		console.error('tools uninstall 缺少工具名称。');
		console.error('用法: ccq tools uninstall <name> [--yes|-y]');
		return 1;
	}

	const id = resolveToolId(name);
	if (!id) {
		console.error(`未知工具: ${name}`);
		printAvailableTools();
		return 1;
	}

	const confirmed = await confirmDangerousAction({
		prompt: `确认卸载工具 ${id} 吗？`,
		assumedYes
	});
	if (!confirmed) {
		console.log('已取消卸载。');
		return 1;
	}

	const outcome = await uninstallComponent(id, createConsoleProgress());
	if (!outcome.success) {
		console.error(outcome.error ?? '卸载失败');
		return 1;
	}

	return 0;
}

function selectUpdateTargets(components: readonly ManagedComponent[], name: string | undefined): {ok: true; components: readonly ManagedComponent[]} | {ok: false; error: string} {
	if (name) {
		const id = resolveToolId(name);
		if (!id) {
			return {ok: false, error: `未知工具: ${name}`};
		}

		const component = components.find(item => item.id === id);
		if (!component) {
			return {ok: false, error: `未找到工具: ${name}`};
		}

		return {ok: true, components: component.hasUpdate === true ? [component] : []};
	}

	return {ok: true, components: components.filter(item => item.hasUpdate === true)};
}

function resolveToolId(name: string): ComponentId | null {
	return TOOL_ALIASES[name.toLowerCase()] ?? null;
}

function printAvailableTools(components?: readonly ManagedComponent[]): void {
	const ids = components?.map(item => item.id) ?? ['ClaudeCode', 'Ccline', 'CcgWorkflow', 'OpenSpec', 'CodeGraph', 'CodexCli', 'AntigravityCli'];
	console.error('可用工具:');
	for (const id of ids) {
		console.error(`  ${id}`);
	}
}
