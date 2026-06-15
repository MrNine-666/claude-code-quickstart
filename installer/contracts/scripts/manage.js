#!/usr/bin/env node
/**
 * Manage - 统一管理入口（子菜单路由器）
 *
 * 职责：显示管理子菜单，路由到各专项管理器
 * - Provider 管理 → provider-manager.js
 * - Skills 管理   → skills-manager.js
 * - Update 管理   → update-manager.js
 * - MCP 管理      → mcp-manager.js
 *
 * 架构：
 * - [常量层] SCRIPT_VERSION、路径、颜色
 * - [工具层] displayWidth、pad、colorize、atomicWrite、withProfileLock、ensureTmpCacheDir
 * - [渲染层] showMainMenu
 * - [路由层] main() → 根据用户选择调用对应管理器
 *
 * @author 哈雷酱（傲娇大小姐工程师）
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const readline = require('readline');
const { spawn } = require('child_process');
const tty = require('tty');

// ============================================================================
// 常量层
// ============================================================================

const SCRIPT_VERSION = '1.0.0';

// 路径
const HOME = process.env.HOME || process.env.USERPROFILE;
const PROFILE_LOCK_FILE = path.join(os.tmpdir(), '.ccq-profile.lock');
const PROFILE_LOCK_TIMEOUT_MS = 30000;

// 颜色语义系统（与 mcp-manager.js 保持一致）
const COLORS = {
  primary:  '\x1b[38;2;217;119;87m',  // Claude Orange
  success:  '\x1b[92m',   // 亮绿
  warning:  '\x1b[93m',   // 亮黄
  danger:   '\x1b[91m',   // 亮红
  info:     '\x1b[97m',   // 白
  dim:      '\x1b[90m',   // 灰
  reset:    '\x1b[0m'
};

// TTY 检测与流准备（复用 mcp-manager.js 的 TTY 处理逻辑）
let IS_TTY = false;
let TTY_INPUT = process.stdin;
let TTY_OUTPUT = process.stdout;
let TTY_OWNS_FD = false;

try {
  const ttyFd = fs.openSync('/dev/tty', 'r+');
  fs.closeSync(ttyFd);
  IS_TTY = true;

  TTY_INPUT = new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
  TTY_OUTPUT = new tty.WriteStream(fs.openSync('/dev/tty', 'w'));
  TTY_OWNS_FD = true;
} catch (e) {
  IS_TTY = process.stdin.isTTY && process.stdout.isTTY;
  TTY_INPUT = process.stdin;
  TTY_OUTPUT = process.stdout;
  TTY_OWNS_FD = false;
}

const SUPPORTS_ANSI = IS_TTY;

/**
 * 全局清理：销毁 TTY 流
 */
function cleanupGlobalTTY() {
  if (TTY_OWNS_FD && TTY_INPUT && TTY_OUTPUT) {
    try {
      if (TTY_INPUT.isTTY && typeof TTY_INPUT.setRawMode === 'function') {
        TTY_INPUT.setRawMode(false);
      }
      TTY_INPUT.destroy();
      TTY_OUTPUT.destroy();
    } catch (e) {
      // 静默失败
    }
  }
}

// ============================================================================
// 工具层
// ============================================================================

/**
 * 计算字符串的显示宽度（CJK 字符 = 2，ASCII = 1）
 */
function displayWidth(str) {
  if (!str) return 0;
  return Array.from(str).reduce((width, char) => {
    const code = char.codePointAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3000 && code <= 0x303F) ||
        (code >= 0xFF00 && code <= 0xFFEF)) {
      return width + 2;
    }
    return width + 1;
  }, 0);
}

/**
 * 填充字符串到指定显示宽度
 */
function pad(str, width) {
  const dw = displayWidth(str);
  const padding = width - dw;
  return str + ' '.repeat(Math.max(0, padding));
}

/**
 * 带颜色输出
 */
function colorize(text, colorKey) {
  if (!SUPPORTS_ANSI) return text;
  return COLORS[colorKey] + text + COLORS.reset;
}

/**
 * 原子写入文件（任务 1.2：从 mcp-manager.js 提取）
 *
 * 实现：临时文件 + rename 保证原子性
 * 来源：mcp-manager.js 157-172 行
 */
function atomicWrite(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) {
    fs.mkdirSync(dir, { recursive: true });
  }

  const tempPath = filePath + '.tmp.' + Date.now() + '.' + process.pid;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
    return true;
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch {}
    throw err;
  }
}

/**
 * Profile 级别文件锁（任务 1.3：实现 withProfileLock）
 *
 * 防止并发 ccq 调用竞态写入 Profile
 * 锁文件：~/.tmp/.ccq-profile.lock
 * 超时：30 秒
 * 过期清理：5 分钟
 */
function withProfileLock(action) {
  const start = Date.now();
  const timeout = PROFILE_LOCK_TIMEOUT_MS;

  // 自旋等待锁
  while (true) {
    try {
      // 尝试创建锁文件（exclusive）
      const fd = fs.openSync(PROFILE_LOCK_FILE, 'wx');
      fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      fs.closeSync(fd);
      break;  // 成功获取锁
    } catch (err) {
      if (Date.now() - start > timeout) {
        throw new Error('无法获取 Profile 锁（30s 超时），可能有其他 CCQ 进程正在修改 Profile');
      }

      // 检查锁是否过期（超过 5 分钟）
      try {
        const stat = fs.statSync(PROFILE_LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 300000) {
          fs.unlinkSync(PROFILE_LOCK_FILE);  // 清理过期锁
        }
      } catch {}

      // 自旋等待 100ms
      const sleepEnd = Date.now() + 100;
      while (Date.now() < sleepEnd) { /* busy wait */ }
    }
  }

  // 执行操作并释放锁
  try {
    return action();
  } finally {
    try {
      fs.unlinkSync(PROFILE_LOCK_FILE);
    } catch {}
  }
}

/**
 * 临时缓存目录初始化（任务 1.3.1：实现 HC-CACHE-TMPDIR）
 *
 * 路径：$TMPDIR/ccq-cache-<uid>/（Unix 用 UID，Windows 用 PID）
 * 权限：0o700（仅当前用户）
 * 清理：系统重启自动清理
 */
function ensureTmpCacheDir() {
  const uid = process.getuid ? process.getuid() : process.pid;
  const tmpCacheDir = path.join(os.tmpdir(), `ccq-cache-${uid}`);

  if (!fs.existsSync(tmpCacheDir)) {
    fs.mkdirSync(tmpCacheDir, { recursive: true, mode: 0o700 });
  }

  return tmpCacheDir;
}

// ============================================================================
// 渲染层
// ============================================================================

/**
 * 显示主菜单并返回用户选择
 */
async function showMainMenu() {
  if (!IS_TTY) {
    console.error(colorize('❌ 错误：管理面板需要交互式终端', 'danger'));
    console.error(colorize('提示：请直接在终端运行，不要通过管道或重定向', 'dim'));
    process.exit(1);
  }

  console.log('');
  console.log(colorize('═══════════════════════════════════════════', 'primary'));
  console.log(colorize('       Claude Code Quickstart 管理面板       ', 'primary'));
  console.log(colorize('═══════════════════════════════════════════', 'primary'));
  console.log('');
  console.log(colorize('[1]', 'info') + ' Provider 管理 - 供应商配置与切换');
  console.log(colorize('[2]', 'info') + ' Skills 管理   - 技能发现、安装、更新');
  console.log(colorize('[3]', 'info') + ' Update 管理   - 检查并应用组件更新');
  console.log(colorize('[4]', 'info') + ' MCP 管理      - MCP Server 配置管理');
  console.log('');
  console.log(colorize('[0]', 'dim') + ' 退出');
  console.log('');

  const rl = readline.createInterface({
    input: TTY_INPUT,
    output: TTY_OUTPUT
  });

  return new Promise((resolve) => {
    rl.question(colorize('请选择功能 [0-4]: ', 'primary'), (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

// ============================================================================
// 路由层
// ============================================================================

/**
 * 调用子管理器（通过 spawn 执行独立 JS 脚本）
 */
function invokeManager(managerName) {
  const scriptsDir = path.join(HOME, '.ccq', 'scripts');
  const scriptPath = path.join(scriptsDir, `${managerName}.js`);

  if (!fs.existsSync(scriptPath)) {
    console.error(colorize(`❌ 错误：${managerName}.js 脚本不存在`, 'danger'));
    console.error(colorize(`路径：${scriptPath}`, 'dim'));
    console.error(colorize('提示：请重新运行安装脚本', 'warning'));
    process.exit(1);
  }

  // 使用 spawn 继承 stdio，保证子管理器的交互式菜单正常工作
  const child = spawn('node', [scriptPath], {
    stdio: 'inherit',
    cwd: process.cwd(),
    env: process.env
  });

  child.on('exit', (code) => {
    process.exit(code || 0);
  });

  child.on('error', (err) => {
    console.error(colorize(`❌ 启动 ${managerName} 失败: ${err.message}`, 'danger'));
    process.exit(1);
  });
}

/**
 * 主入口
 */
async function main() {
  try {
    // 确保临时缓存目录存在（任务 1.3.1）
    ensureTmpCacheDir();

    // 显示主菜单
    const choice = await showMainMenu();

    // 路由到对应管理器
    switch (choice) {
      case '1':
        invokeManager('provider-manager');
        break;
      case '2':
        invokeManager('skills-manager');
        break;
      case '3':
        invokeManager('update-manager');
        break;
      case '4':
        invokeManager('mcp-manager');
        break;
      case '0':
        console.log(colorize('退出管理面板', 'dim'));
        process.exit(0);
        break;
      default:
        console.error(colorize('❌ 无效选择，请输入 0-4', 'danger'));
        process.exit(1);
    }
  } catch (err) {
    console.error(colorize(`❌ 发生错误: ${err.message}`, 'danger'));
    if (err.stack) {
      console.error(colorize(err.stack, 'dim'));
    }
    process.exit(1);
  } finally {
    cleanupGlobalTTY();
  }
}

// 注册退出清理
process.on('exit', cleanupGlobalTTY);
process.on('SIGINT', () => {
  cleanupGlobalTTY();
  process.exit(130);
});
process.on('SIGTERM', () => {
  cleanupGlobalTTY();
  process.exit(143);
});

// 执行主入口
if (require.main === module) {
  main().catch((err) => {
    console.error(colorize(`❌ 未捕获异常: ${err.message}`, 'danger'));
    process.exit(1);
  });
}

// 导出供其他模块使用
module.exports = {
  atomicWrite,
  withProfileLock,
  ensureTmpCacheDir,
  displayWidth,
  pad,
  colorize
};
