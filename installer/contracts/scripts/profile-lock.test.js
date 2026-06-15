#!/usr/bin/env node
/**
 * manage.js withProfileLock 并发锁测试
 *
 * 测试范围：
 * 1. 互斥语义：同时获取锁时第二个必须等待或超时
 * 2. 锁释放：正常执行后锁被清理
 * 3. 过期清理：超过 5 分钟的陈旧锁自动清理
 * 4. 超时保护：30 秒超时防止死锁
 *
 * 运行：node profile-lock.test.js
 */

'use strict';

const assert = require('assert');
const fs = require('fs');
const path = require('path');
const os = require('os');

// 导入 manage.js 的 withProfileLock
const { withProfileLock } = require('./manage.js');

// 锁文件路径（与 manage.js 保持一致）
const PROFILE_LOCK_FILE = path.join(os.tmpdir(), '.ccq-profile.lock');

// ============================================================================
// 测试框架（零依赖迷你版）
// ============================================================================

let testCount = 0;
let passCount = 0;
let failCount = 0;

function test(name, fn) {
  testCount++;
  return (async () => {
    try {
      await fn();
      passCount++;
      console.log(`✓ ${name}`);
    } catch (err) {
      failCount++;
      console.error(`✗ ${name}`);
      console.error(`  ${err.message}`);
      if (err.stack) {
        console.error(`  ${err.stack.split('\n').slice(1, 3).join('\n')}`);
      }
    }
  })();
}

function suite(name, fn) {
  console.log(`\n━━━ ${name} ━━━`);
  return fn();
}

// ============================================================================
// 测试前后清理
// ============================================================================

function cleanup() {
  try {
    if (fs.existsSync(PROFILE_LOCK_FILE)) {
      fs.unlinkSync(PROFILE_LOCK_FILE);
    }
  } catch {}
}

// ============================================================================
// 1. 基础互斥测试
// ============================================================================

suite('基础互斥语义', async () => {
  await test('锁获取后执行完毕自动释放', async () => {
    cleanup();

    let executed = false;
    withProfileLock(() => {
      executed = true;
    });

    assert.strictEqual(executed, true, '回调必须被执行');
    assert.strictEqual(fs.existsSync(PROFILE_LOCK_FILE), false, '锁文件必须被清理');
  });

  await test('锁获取后返回值正确传递', async () => {
    cleanup();

    const result = withProfileLock(() => {
      return 'test-return-value';
    });

    assert.strictEqual(result, 'test-return-value', '返回值必须正确传递');
  });

  await test('异常情况下锁仍被释放', async () => {
    cleanup();

    try {
      withProfileLock(() => {
        throw new Error('模拟异常');
      });
      assert.fail('应该抛出异常');
    } catch (err) {
      assert.strictEqual(err.message, '模拟异常');
    }

    assert.strictEqual(fs.existsSync(PROFILE_LOCK_FILE), false, '异常后锁文件必须被清理');
  });
});

// ============================================================================
// 2. 过期清理测试
// ============================================================================

suite('过期锁清理', async () => {
  await test('超过 5 分钟的陈旧锁被自动清理', async () => {
    cleanup();

    // 创建陈旧锁文件（修改 mtime 为 6 分钟前）
    fs.writeFileSync(PROFILE_LOCK_FILE, `99999\n${Date.now()}\n`);
    const staleTime = Date.now() - (6 * 60 * 1000); // 6 分钟前
    fs.utimesSync(PROFILE_LOCK_FILE, new Date(staleTime), new Date(staleTime));

    let executed = false;
    withProfileLock(() => {
      executed = true;
    });

    assert.strictEqual(executed, true, '陈旧锁被清理后必须能获取新锁');
  });
});

// ============================================================================
// 3. 并发竞争测试（通过 setTimeout 模拟）
// ============================================================================

suite('并发竞争场景', async () => {
  await test('第一个持锁时第二个必须等待', async () => {
    cleanup();

    let firstEntered = false;
    let firstExited = false;
    let secondEntered = false;

    // 第一个锁：持有 200ms
    setTimeout(() => {
      withProfileLock(() => {
        firstEntered = true;
        const start = Date.now();
        while (Date.now() - start < 200) { /* busy wait */ }
        firstExited = true;
      });
    }, 0);

    // 第二个锁：50ms 后尝试获取，必须等待第一个释放
    setTimeout(() => {
      withProfileLock(() => {
        secondEntered = true;
        // 验证顺序：第一个必须已退出
        assert.strictEqual(firstExited, true, '第二个获取锁时第一个必须已释放');
      });
    }, 50);

    // 等待双方完成（总耗时约 200ms + 自旋等待）
    await new Promise(resolve => setTimeout(resolve, 500));

    assert.strictEqual(firstEntered, true, '第一个必须执行');
    assert.strictEqual(secondEntered, true, '第二个必须在第一个释放后执行');
  });
});

// ============================================================================
// 4. 超时保护测试（简化：验证超时配置存在）
// ============================================================================

suite('超时保护', async () => {
  await test('超时配置存在且合理', async () => {
    // 读取 manage.js 源码验证超时配置
    const manageSource = fs.readFileSync(path.join(__dirname, 'manage.js'), 'utf8');

    // 验证 PROFILE_LOCK_TIMEOUT_MS 定义
    const timeoutMatch = manageSource.match(/PROFILE_LOCK_TIMEOUT_MS\s*=\s*(\d+)/);
    assert(timeoutMatch, '必须定义 PROFILE_LOCK_TIMEOUT_MS');

    const timeout = Number(timeoutMatch[1]);
    assert(timeout >= 10000 && timeout <= 60000, '超时必须在 10s-60s 合理范围内');
  });
});

// ============================================================================
// 5. 锁文件路径测试
// ============================================================================

suite('锁文件路径', async () => {
  await test('锁文件位于系统临时目录', async () => {
    assert(PROFILE_LOCK_FILE.includes(os.tmpdir()), '锁文件必须在 tmpdir');
    assert(PROFILE_LOCK_FILE.includes('.ccq-profile.lock'), '锁文件名必须包含 .ccq-profile.lock');
  });
});

// ============================================================================
// 测试结果汇总
// ============================================================================

cleanup(); // 最终清理

setTimeout(() => {
  console.log(`\n━━━ 测试结果 ━━━`);
  console.log(`总计: ${testCount} | 通过: ${passCount} | 失败: ${failCount}`);
  process.exit(failCount > 0 ? 1 : 0);
}, 600); // 等待异步测试完成
