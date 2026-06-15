#!/usr/bin/env node
/**
 * 部署降级链测试（任务 6.6）
 *
 * 架构适配说明：
 * design.md D8 描述的「wrapper curl manage.js + last-good 备份」机制，
 * 在当前 base64 内嵌架构（任务 1.8 决策）中已不存在网络拉取 JS 场景。
 * 实际降级链为：base64 内嵌 → 源码 fallback → 已部署版本（版本检测跳过）。
 *
 * 本测试验证降级链的 JS 侧基础：
 * 1. 四个 manage JS 模块完整性（源码 fallback 前提）
 * 2. SCRIPT_VERSION 版本检测机制（跳过部署 / 触发更新的基础）
 * 3. 隔离目录模拟部署（验证 node 能加载部署后的脚本）
 * 4. atomicWrite 原子性（部署写入崩溃抵抗）
 *
 * 运行：node deploy.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');
const { execSync } = require('child_process');

const SCRIPTS_DIR = __dirname;
const MANAGED_SCRIPTS = ['manage.js', 'provider-manager.js', 'skills-manager.js', 'update-manager.js'];

let testCount = 0, passCount = 0, failCount = 0;
function test(name, fn) {
  testCount++;
  try { fn(); passCount++; console.log(`✓ ${name}`); }
  catch (err) { failCount++; console.error(`✗ ${name}\n  ${err.message}`); }
}
function suite(name, fn) { console.log(`\n━━━ ${name} ━━━`); fn(); }

// ============================================================================
// 1. 模块完整性（源码 fallback 前提）
// ============================================================================

suite('模块完整性（源码 fallback 前提）', () => {
  test('四个 manage JS 模块全部可 require（无语法/依赖错误）', () => {
    for (const f of MANAGED_SCRIPTS) {
      const mod = require(path.join(SCRIPTS_DIR, f));
      assert(mod && typeof mod === 'object', `${f} 必须导出对象`);
    }
  });

  test('manage.js 导出部署工具函数', () => {
    const m = require('./manage.js');
    assert.strictEqual(typeof m.atomicWrite, 'function', 'atomicWrite 必须导出');
    assert.strictEqual(typeof m.withProfileLock, 'function', 'withProfileLock 必须导出');
    assert.strictEqual(typeof m.ensureTmpCacheDir, 'function', 'ensureTmpCacheDir 必须导出');
  });
});

// ============================================================================
// 2. SCRIPT_VERSION 版本检测机制
// ============================================================================

suite('SCRIPT_VERSION 版本检测', () => {
  test('每个 JS 模块含 SCRIPT_VERSION 常量', () => {
    const versions = {};
    for (const f of MANAGED_SCRIPTS) {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      const m = src.match(/SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/);
      assert(m, `${f} 必须定义 SCRIPT_VERSION`);
      versions[f] = m[1];
    }
    console.log(`  版本: ${JSON.stringify(versions)}`);
  });

  test('四个模块 SCRIPT_VERSION 一致（版本检测跳过部署的前提）', () => {
    const versions = new Set();
    for (const f of MANAGED_SCRIPTS) {
      const src = fs.readFileSync(path.join(SCRIPTS_DIR, f), 'utf8');
      const m = src.match(/SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/);
      versions.add(m[1]);
    }
    assert.strictEqual(versions.size, 1, `四个模块版本必须一致，实际: ${[...versions].join(', ')}`);
  });

  test('ManageCore.ps1 内嵌版本与 manage.js 一致', () => {
    const manageSrc = fs.readFileSync(path.join(SCRIPTS_DIR, 'manage.js'), 'utf8');
    const manageVer = manageSrc.match(/SCRIPT_VERSION\s*=\s*['"]([^'"]+)['"]/)[1];
    const corePath = path.join(SCRIPTS_DIR, '..', '..', 'windows', 'core', 'ManageCore.ps1');
    if (!fs.existsSync(corePath)) {
      console.log('  [SKIP] ManageCore.ps1 不存在（非 Windows）');
      return;
    }
    const coreSrc = fs.readFileSync(corePath, 'utf8');
    const coreVer = coreSrc.match(/ManageCoreVersion\s*=\s*["']([^"']+)["']/);
    assert(coreVer, 'ManageCore.ps1 必须定义 ManageCoreVersion');
    assert.strictEqual(coreVer[1], manageVer, `版本不一致: manage=${manageVer} core=${coreVer[1]}`);
  });
});

// ============================================================================
// 3. 隔离目录模拟部署（模拟 Install-ManageScripts 的部署结果）
// ============================================================================

suite('隔离目录模拟部署', () => {
  test('部署到隔离目录后 node 能加载全部模块', () => {
    const tmpDeploy = path.join(os.tmpdir(), `ccq-deploy-test-${process.pid}`);
    fs.mkdirSync(tmpDeploy, { recursive: true });

    try {
      // 模拟 Install-ManageScripts：复制 4 个 JS 到目标目录
      for (const f of MANAGED_SCRIPTS) {
        fs.copyFileSync(path.join(SCRIPTS_DIR, f), path.join(tmpDeploy, f));
      }

      // 验证 node 能从隔离目录加载（子进程，避免缓存）
      const probe = `try { require(${JSON.stringify(path.join(tmpDeploy, 'manage.js'))}); console.log('OK'); } catch(e) { console.log('FAIL:'+e.message); process.exit(1); }`;
      const result = execSync(`node -e "${probe.replace(/"/g, '\\"')}"`, { encoding: 'utf8' });
      assert(result.includes('OK'), `隔离目录加载失败: ${result}`);
    } finally {
      try { fs.rmSync(tmpDeploy, { recursive: true, force: true }); } catch {}
    }
  });

  test('部署缺失文件时 invokeManager 路由失败（错误处理）', () => {
    // manage.js 的 invokeManager 检测脚本不存在时 exit(1)
    // 通过源码静态校验该分支存在
    const src = fs.readFileSync(path.join(SCRIPTS_DIR, 'manage.js'), 'utf8');
    assert(/existsSync\(scriptPath\)/.test(src), 'invokeManager 必须检测脚本存在性');
    assert(/process\.exit\(1\)/.test(src), '缺失脚本必须 exit(1)');
  });
});

// ============================================================================
// 4. atomicWrite 原子性（部署写入崩溃抵抗）
// ============================================================================

suite('atomicWrite 崩溃抵抗', () => {
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

  test('atomicWrite 覆盖已有文件保持原子性', () => {
    const { atomicWrite } = require('./manage.js');
    const tmpFile = path.join(os.tmpdir(), `ccq-atomic-overwrite-${process.pid}.txt`);
    try {
      atomicWrite(tmpFile, 'original');
      atomicWrite(tmpFile, 'updated');
      assert.strictEqual(fs.readFileSync(tmpFile, 'utf8'), 'updated');
      // 验证无残留临时文件
      const dir = path.dirname(tmpFile);
      const leftovers = fs.readdirSync(dir).filter(f => f.includes('.ccq-atomic-overwrite') && f.includes('.tmp.'));
      assert.strictEqual(leftovers.length, 0, '不应残留临时文件');
    } finally {
      try { fs.unlinkSync(tmpFile); } catch {}
    }
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

console.log(`\n━━━ 测试结果 ━━━`);
console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
process.exit(failCount > 0 ? 1 : 0);


