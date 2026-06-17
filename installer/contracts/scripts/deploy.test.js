#!/usr/bin/env node
/**
 * 部署/调用链测试（P10 任务 10.4.1 / 10.4.5）
 *
 * 架构：P10 方案 3 —— esbuild 单文件 bundle + 固定目录缓存 wrapper。
 * 旧 base64 内嵌部署 / SCRIPT_VERSION 版本检测 / ManageScriptNames 部署清单已废弃删除，
 * 本测试不再断言它们；改为验证新架构契约：
 *   1. 模块完整性（可 require 的 manage JS 模块，bundle 入口前提）
 *   2. invokeManager 同进程 require 调用（取代 spawn 独立进程 + existsSync 路径检测）
 *   3. ManageCore wrapper 缓存解析（源码优先 → 缓存 TTL → 下载降级）
 *   4. build 用 esbuild bundle（取代 Get-ManageScriptsBase64 多文件 base64）
 *   5. build.json Manage 产物内嵌 ManageCore + 源码入口调用 JS 面板
 *   6. atomicWrite 原子性 / ensureTmpCacheDir
 *
 * 运行：node deploy.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

const SCRIPTS_DIR = __dirname;
const ROOT = path.join(SCRIPTS_DIR, '..', '..'); // installer/
const REQUIRABLE = ['manage.js', 'provider-manager.js', 'skills-manager.js', 'update-manager.js'];
const SUBMANAGERS = ['provider-manager.js', 'skills-manager.js', 'update-manager.js', 'mcp-manager.js'];

let testCount = 0, passCount = 0, failCount = 0;
function test(name, fn) {
  testCount++;
  try { fn(); passCount++; console.log(`✓ ${name}`); }
  catch (err) { failCount++; console.error(`✗ ${name}\n  ${err.message}`); }
}
function suite(name, fn) { console.log(`\n━━━ ${name} ━━━`); fn(); }
function readIf(p) { return fs.existsSync(p) ? fs.readFileSync(p, 'utf8') : null; }

// ============================================================================
// 1. 模块完整性（bundle 入口前提）
// ============================================================================

suite('模块完整性（bundle 入口前提）', () => {
  test('可 require 的 manage JS 模块全部加载（无语法/依赖错误）', () => {
    for (const f of REQUIRABLE) {
      const mod = require(path.join(SCRIPTS_DIR, f));
      assert(mod && typeof mod === 'object', `${f} 必须导出对象`);
    }
  });

  test('manage.js 导出共享工具函数（atomicWrite/withProfileLock/ensureTmpCacheDir）', () => {
    const m = require('./manage.js');
    assert.strictEqual(typeof m.atomicWrite, 'function', 'atomicWrite 必须导出');
    assert.strictEqual(typeof m.withProfileLock, 'function', 'withProfileLock 必须导出');
    assert.strictEqual(typeof m.ensureTmpCacheDir, 'function', 'ensureTmpCacheDir 必须导出');
  });
});

// ============================================================================
// 2. invokeManager 同进程 require 调用（P10 任务 10.1.3）
// ============================================================================

suite('invokeManager 同进程 require 调用（取代 spawn 独立进程）', () => {
  const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'manage.js'), 'utf8');

  test('invokeManager 用 require 静态映射加载子模块', () => {
    assert(/require\(['"]\.\/provider-manager['"]\)/.test(src), '必须 require provider-manager');
    assert(/require\(['"]\.\/mcp-manager['"]\)/.test(src), '必须 require mcp-manager');
  });

  test('invokeManager 调用子模块 runInteractive 入口', () => {
    assert(/runInteractive/.test(src), '必须调用 runInteractive');
  });

  test('manage.js 入口不再依赖 child_process（require 同进程取代 spawn 部署）', () => {
    assert(!/require\(\s*['"]child_process['"]\s*\)/.test(src),
      'manage.js 不应 require child_process（P10 已用 require 同进程取代 spawn）');
  });

  test('四个子模块均导出 runInteractive 入口', () => {
    for (const f of SUBMANAGERS) {
      const mSrc = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      assert(/runInteractive/.test(mSrc), `${f} 必须导出 runInteractive`);
    }
  });

  test('provider runInteractive 已接入真实 TUI Dashboard（非 Phase 1b 占位，任务 11.1.8 防回归）', () => {
    const pSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'provider-manager.js'), 'utf8');
    // 不得残留 Phase 1a/1b 占位串
    assert(!/Phase 1a 核心逻辑已就绪/.test(pSrc), 'provider-manager.js 不得残留 Phase 1a 占位说明');
    assert(!/交互式 TUI Dashboard 待 Phase 1b 接入/.test(pSrc), 'provider-manager.js 不得残留 Phase 1b 待接入占位');
    // 必须含真实 Dashboard 实现（主循环 + Fallback + CRUD 交互）
    assert(/function showProviderDashboard\b/.test(pSrc), '必须实现 showProviderDashboard 主循环');
    assert(/function showProviderDashboardFallback\b/.test(pSrc), '必须实现 Fallback 数字菜单降级');
    assert(/function addProviderInteractive\b/.test(pSrc), '必须实现 Add 多级交互');
    assert(/function editProviderInteractive\b/.test(pSrc), '必须实现 Edit 交互');
    assert(/function removeProviderInteractive\b/.test(pSrc), '必须实现 Remove 交互');
    assert(/function editManagedModelEnvInteractive\b/.test(pSrc), '必须实现模型环境键交互');
    // runInteractive 必须路由到真实 Dashboard（而非占位 banner）
    assert(/await showProviderDashboard\(\)/.test(pSrc), 'runInteractive 必须调用真实 showProviderDashboard');
  });
});

// ============================================================================
// 3. ManageCore wrapper 缓存解析契约（P10 任务 10.2.3 / 10.2.4）
// ============================================================================

suite('ManageCore wrapper 缓存解析契约', () => {
  test('ManageCore.ps1 实现源码优先 → 缓存 TTL → 下载', () => {
    const s = readIf(path.join(ROOT, 'windows', 'core', 'ManageCore.ps1'));
    if (!s) { console.log('  [SKIP] ManageCore.ps1 不存在'); return; }
    assert(/Resolve-ManageScript/.test(s), '必须有 Resolve-ManageScript');
    assert(/Get-SourceManageScript/.test(s), '必须有源码探测 Get-SourceManageScript');
    assert(/ManageCacheTtlHours/.test(s), '必须定义缓存 TTL');
    assert(/Invoke-WebRequest/.test(s), '缓存过期必须下载');
    assert(/releases\/latest\/download\/manage\.js/.test(s), '必须用固定 Release URL');
    assert(!/ManageScriptNames/.test(s), '旧部署清单 ManageScriptNames 必须删除');
    assert(!/ManageCoreVersion/.test(s), '旧版本检测 ManageCoreVersion 必须删除');
  });

  test('ManageCore.zsh 对称实现缓存解析', () => {
    const s = readIf(path.join(ROOT, 'macos', 'core', 'ManageCore.zsh'));
    if (!s) { console.log('  [SKIP] ManageCore.zsh 不存在'); return; }
    assert(/ccq_manage_core_resolve_script/.test(s), '必须有 resolve 函数');
    assert(/ccq_manage_core_source_script/.test(s), '必须有源码探测');
    assert(/CCQ_MANAGE_CACHE_TTL_SECONDS/.test(s), '必须定义缓存 TTL（秒）');
    assert(/curl /.test(s), '缓存过期必须 curl 下载');
    assert(/releases\/latest\/download\/manage\.js/.test(s), '必须用固定 Release URL');
    assert(!/CCQ_MANAGE_SCRIPT_NAMES/.test(s), '旧部署清单 CCQ_MANAGE_SCRIPT_NAMES 必须删除');
  });
});

// ============================================================================
// 4. build 用 esbuild 单文件 bundle（P10 任务 10.1.1 / 10.1.5）
// ============================================================================

suite('build 用 esbuild 单文件 bundle（取代 base64 多文件内嵌）', () => {
  test('build.ps1 调用 esbuild 构建 manage.js bundle', () => {
    const s = readIf(path.join(ROOT, 'build.ps1'));
    if (!s) { console.log('  [SKIP] build.ps1 不存在'); return; }
    assert(/Invoke-ManageBundleBuild/.test(s), '必须有 Invoke-ManageBundleBuild');
    assert(/esbuild\.config\.js/.test(s), '必须调用 esbuild.config.js');
    assert(!/Get-ManageScriptsBase64/.test(s), '旧 Get-ManageScriptsBase64 必须删除');
  });

  test('build.sh 调用 esbuild 构建 manage.js bundle', () => {
    const s = readIf(path.join(ROOT, 'build.sh'));
    if (!s) { console.log('  [SKIP] build.sh 不存在'); return; }
    assert(/buildManageBundle/.test(s), '必须有 buildManageBundle');
    assert(/esbuild\.config\.js/.test(s), '必须调用 esbuild.config.js');
    assert(!/getManageScriptsBase64/.test(s), '旧 getManageScriptsBase64 必须删除');
  });
});

// ============================================================================
// 5. Manage 产物结构契约（仍有效）
// ============================================================================

suite('Manage 产物结构契约', () => {
  test('build.json Manage 产物 CoreFiles 内嵌 ManageCore（artifact 级）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'build.json'), 'utf8'));
    const winManage = manifest.Windows.Artifacts.find(a => a.Role === 'Manage');
    assert(winManage, 'build.json 必须包含 Windows Manage artifact');
    assert(winManage.CoreFiles.includes('windows/core/ManageCore.ps1'), 'Windows Manage CoreFiles 必须含 ManageCore.ps1');
    const macManage = manifest.MacOS.Artifacts.find(a => a.Role === 'Manage');
    assert(macManage && macManage.CoreFiles, 'macOS Manage artifact 必须有 CoreFiles（artifact 级）');
    assert(macManage.CoreFiles.includes('macos/core/ManageCore.zsh'), 'macOS Manage artifact CoreFiles 必须含 ManageCore.zsh');
  });

  test('build.json Install 产物 CoreFiles 隔离不含 ManageCore（P10 macOS 粒度修复）', () => {
    const manifest = JSON.parse(fs.readFileSync(path.join(ROOT, 'contracts', 'build.json'), 'utf8'));
    // Windows Install 本就不含 ManageCore（既有正确架构）
    const winInstall = manifest.Windows.Artifacts.find(a => a.Role === 'Install');
    assert(winInstall && !winInstall.CoreFiles.includes('windows/core/ManageCore.ps1'),
      'Windows Install CoreFiles 不应含 ManageCore');
    // macOS Install 粒度修复后也不含 ManageCore（消除 dead code 内联）
    const macInstall = manifest.MacOS.Artifacts.find(a => a.Role === 'Install');
    assert(macInstall && macInstall.CoreFiles, 'macOS Install artifact 必须有 CoreFiles');
    assert(!macInstall.CoreFiles.includes('macos/core/ManageCore.zsh'),
      'macOS Install CoreFiles 不应含 ManageCore（消除 dead code 内联）');
    // macOS 不再有平台级 CoreFiles（已迁移到 artifact 级单一数据源）
    assert(!manifest.MacOS.CoreFiles, 'macOS 不应再有平台级 CoreFiles（已迁移到 artifact 级）');
  });

  test('源码 Manage 入口交互模式调用 JS 统一面板', () => {
    const ps = fs.readFileSync(path.join(ROOT, 'windows', 'Manage.ps1'), 'utf8');
    const zsh = fs.readFileSync(path.join(ROOT, 'macos', 'Manage.zsh'), 'utf8');
    assert(/Show-ManagePanel/.test(ps), 'Windows Manage.ps1 交互模式必须调用 Show-ManagePanel');
    assert(/core\\ManageCore\.ps1/.test(ps), 'Windows Manage.ps1 必须 dot-source ManageCore.ps1');
    assert(/ccq_manage_core_show_panel/.test(zsh), 'macOS Manage.zsh 交互模式必须调用 ccq_manage_core_show_panel');
    assert(/\bManageCore\b/.test(zsh), 'macOS Manage.zsh 必须 source ManageCore.zsh');
  });
});

// ============================================================================
// 6. 共享工具：atomicWrite 崩溃抵抗 + 临时缓存目录
// ============================================================================

suite('共享工具：atomicWrite 崩溃抵抗 + 临时缓存目录', () => {
  test('atomicWrite 成功写入新文件', () => {
    const { atomicWrite } = require('./manage.js');
    const tmpFile = path.join(os.tmpdir(), `ccq-atomic-${process.pid}.txt`);
    try {
      atomicWrite(tmpFile, 'test content');
      assert.strictEqual(fs.readFileSync(tmpFile, 'utf8'), 'test content');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  });

  test('atomicWrite 覆盖已有文件保持原子性（不残留临时文件）', () => {
    const { atomicWrite } = require('./manage.js');
    const tmpFile = path.join(os.tmpdir(), `ccq-atomic-overwrite-${process.pid}.txt`);
    try {
      atomicWrite(tmpFile, 'original');
      atomicWrite(tmpFile, 'updated');
      assert.strictEqual(fs.readFileSync(tmpFile, 'utf8'), 'updated');
      const leftovers = fs.readdirSync(path.dirname(tmpFile))
        .filter(f => f.includes('.ccq-atomic-overwrite') && f.includes('.tmp.'));
      assert.strictEqual(leftovers.length, 0, '不应残留临时文件');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  });

  test('ensureTmpCacheDir 创建固定缓存目录（系统重启清理）', () => {
    const { ensureTmpCacheDir } = require('./manage.js');
    const dir = ensureTmpCacheDir();
    assert(fs.existsSync(dir), '缓存目录必须存在');
    assert(/ccq-cache-/.test(dir), '路径含 ccq-cache- 前缀');
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);
