import {act} from 'react';
import {testRender} from '@opentui/react/test-utils';
import {describe, expect, test} from 'bun:test';
import type {InstalledSkillItem} from '../../src/core/skills-installed.js';
import {createInitialSkillsViewState, SKILLS_MANAGE_TARGET_ORDER} from '../../src/state/skills-view-state.js';
import {
	SkillsInstallTargetModal,
	skillsModalOpen,
	SkillsTopologyConfirmModal,
	SkillsUninstallConfirm
} from '../../src/views/skills/SkillsModals.js';

// A 类改写（P1-G3）：verify-skills-render.mjs / verify-skills-view.mjs
//   6 skillsModalOpen 只对 Modal 模式返回 true
//   20/21 管理 Modal 使用独立的 cc/cx/pi 目标集合，不展开 Pi global/project
//   22 拓扑确认提示旧版安装迁移文案
//   59/60 卸载 Modal 说明删除范围与同名其它来源不受影响

type ItemOverrides = {name?: string; source?: string; path?: string; agents?: readonly string[]};

function item(over: ItemOverrides = {}): InstalledSkillItem {
	const name = over.name ?? 'same';
	const source = over.source ?? 'old/repo';
	const path = over.path ?? `/home/.agents/skills/${name}`;
	const agents = over.agents ?? ['Claude Code', 'Codex'];
	const root = path.includes('.claude')
		? 'claude'
		: path.includes('.codex')
			? 'codex'
			: path.includes('.pi/agent/skills')
				? 'pi-global'
				: path.includes('.pi/skills')
					? 'pi-project'
					: 'agents';
	const identity = `github:${source}`;
	return {
		id: JSON.stringify(['known', name, identity]),
		name,
		provenance: {kind: 'known', identity, source, installSource: source},
		agents,
		projections: [{path, root, scope: 'global', agents}],
		capabilities: {update: true, manageAgents: true, migrate: true, delete: true}
	} as unknown as InstalledSkillItem;
}

describe('skillsModalOpen', () => {
	test('仅 Modal 模式返回 true，列表与安装页不锁背景焦点', () => {
		expect(skillsModalOpen('list')).toBe(false);
		expect(skillsModalOpen('install')).toBe(false);
		expect(skillsModalOpen('busy')).toBe(false);
		for (const mode of [
			'select-install-target',
			'manage-inject',
			'confirm-topology-change',
			'confirm-source-replacement',
			'confirm-uninstall'
		] as const) {
			expect(skillsModalOpen(mode)).toBe(true);
		}
	});
});

describe('SkillsInstallTargetModal 独立目标集合', () => {
	test('管理 Modal 只展示 Claude Code / Codex / Pi，不展开 Pi global/project', async () => {
		expect(SKILLS_MANAGE_TARGET_ORDER).toEqual(['cc', 'cx', 'pi']);
		const installed = [item({agents: ['Claude Code', 'Codex', 'Pi']})];
		const view = {
			...createInitialSkillsViewState(),
			mode: 'manage-inject' as const,
			installed,
			installDraft: {cc: true, cx: true, pi: true}
		};
		const setup = await testRender(<SkillsInstallTargetModal view={view} />, {width: 72, height: 16});
		try {
			const frame = await setup.waitForFrame(output => output.includes('管理安装'));
			expect(frame).toMatch(/Claude Code[\s\S]*Codex[\s\S]*Pi/);
			expect(frame).not.toMatch(/全局原生|项目原生|global|project/);
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});

describe('SkillsTopologyConfirmModal 迁移文案', () => {
	test('旧版 .codex 安装迁移到受管位置时提示用户', async () => {
		const installed = [item({name: 'legacy', source: 'old/repo', path: '/home/.codex/skills/legacy', agents: ['Codex']})];
		const view = {
			...createInitialSkillsViewState(),
			installed,
			installDraft: {cc: true, cx: false, pi: false}
		};
		const setup = await testRender(<SkillsTopologyConfirmModal view={view} />, {width: 72, height: 16});
		try {
			const frame = await setup.waitForFrame(output => output.includes('确认更新安装范围'));
			expect(frame).toContain('检测到旧版安装，应用后会迁移到当前支持的位置。');
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});

describe('SkillsUninstallConfirm 删除范围文案', () => {
	test('说明删除当前实例的全部 Agent 与存储投影，并声明同名其它来源不受影响', async () => {
		const targetItem = item({name: 'pdf', source: 'owner/a', path: '/home/.agents/skills/pdf', agents: ['Codex']});
		const otherItem = item({name: 'pdf', source: 'owner/b', path: '/home/.claude/skills/pdf', agents: ['Claude Code']});
		const view = {
			...createInitialSkillsViewState(),
			mode: 'confirm-uninstall' as const,
			installed: [targetItem, otherItem],
			pickedInstalledIds: [targetItem.id]
		};
		const setup = await testRender(<SkillsUninstallConfirm view={view} />, {width: 72, height: 16});
		try {
			const frame = await setup.waitForFrame(output => output.includes('确认批量卸载 Skill'));
			expect(frame).toContain('的全部 Agent 与存储投影');
			expect(frame).toContain('同名其它来源的 1 个实例不受影响。');
		} finally {
			await act(async () => {
				setup.renderer.destroy();
			});
		}
	});
});
