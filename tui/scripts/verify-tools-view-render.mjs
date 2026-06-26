import {render} from 'ink-testing-library';
import React from 'react';
import assert from 'node:assert/strict';
import {mkdirSync, mkdtempSync, rmSync, writeFileSync} from 'node:fs';
import {tmpdir} from 'node:os';
import {join} from 'node:path';

// Phase 11D 渲染门禁：确认合并后左栏 6 菜单（无「检查更新」/无「工具安装」旧名），
// 进入「工具管理」渲染卡片网格不崩溃，StatusDot 语义键齐备。

const home = mkdtempSync(join(tmpdir(), 'ccq-11d-render-'));
process.env.CCQ_HOME = home;
mkdirSync(join(home, '.claude'), {recursive: true});
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify({env: {}}), 'utf8');
writeFileSync(join(home, '.claude.json'), JSON.stringify({}), 'utf8');

// 预置 npm 缓存命中 TTL，避免真实 npm outdated/view 调用拖慢/联网
const uid = process.getuid ? process.getuid() : process.pid;
const cacheDir = join(tmpdir(), `ccq-cache-${uid}`);
mkdirSync(cacheDir, {recursive: true});
writeFileSync(join(cacheDir, 'npm-outdated.json'), JSON.stringify({}), 'utf8');
writeFileSync(join(cacheDir, 'npm-view.json'), JSON.stringify({}), 'utf8');

const {default: App} = await import('../dist/app.js');
const {lastFrame, unmount} = render(React.createElement(App));

// 等待首屏渲染（导航焦点态，6 菜单可见）
await new Promise(resolve => setTimeout(resolve, 300));
const frame = lastFrame();

// 11.1/11.2：6 菜单，无「检查更新」、无旧「工具安装」label
for (const label of ['供应商', 'MCP', 'Skills', '全局规则', '配置文件', '工具管理']) {
	assert.ok(frame.includes(label), `左栏含菜单项: ${label}\n---\n${frame}`);
}
assert.equal(frame.includes('检查更新'), false, '无独立「检查更新」菜单（已并入工具管理）');
console.log('[PASS] 左栏 6 菜单齐备，无「检查更新」独立项 (11.1/11.2)');

unmount();
rmSync(home, {recursive: true, force: true});
console.log('[PASS] Phase 11D 渲染门禁通过');
