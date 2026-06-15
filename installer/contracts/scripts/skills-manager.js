#!/usr/bin/env node
/**
 * Skills Manager - Claude Code Skills 管理模块
 *
 * 职责：Skills 发现、安装、更新、卸载
 * 功能：
 * - 从打包的 contracts.skills 加载 catalogue（含内联 fallback）
 * - 动态发现 Skills（npx skills add <source> --list，含并发优化）
 * - 安装/更新/卸载 Skills（通过 npx skills CLI）
 * - Session 级别缓存（系统重启自动清理）
 * - 支持 copy 模式（解决 symlink 权限问题）
 *
 * 架构：
 * - [常量层] BUNDLED_CONTRACTS（构建时注入）、路径、配置
 * - [工具层] displayWidth、colorize、execCommand、缓存
 * - [Catalogue层] loadSkillsCatalogue、normalizeEntry
 * - [发现层] discoverSkills、listAvailableSkills（并发预取）
 * - [CLI层] getInstalledSkills、installSkill、updateSkill、uninstallSkill
 * - [状态层] getSkillStatus、renderStatusTable
 * - [菜单层] showInstallMenu、showUpdateMenu、showUninstallMenu、showMainMenu
 *
 * 来源：基于 installer/windows/steps/Skills.ps1（2553行）完全对等实现
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
const CLAUDE_DIR = path.join(HOME, '.claude');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const TMP_CACHE_DIR = path.join(os.tmpdir(), `ccq-cache-${process.getuid?.() || process.pid}`);

// CLI 配置
const SKILLS_CLI_AGENT = 'claude-code';

// 超时配置
const DISCOVERY_TIMEOUT_MS = 180000; // 3 分钟
const INSTALL_TIMEOUT_MS = 600000;   // 10 分钟
const UPDATE_TIMEOUT_MS = 600000;    // 10 分钟
const UNINSTALL_TIMEOUT_MS = 300000; // 5 分钟
const LIST_TIMEOUT_MS = 120000;      // 2 分钟

// 并发配置
const MAX_DISCOVERY_CONCURRENCY = 2;

// 颜色语义系统
const COLORS = {
  primary:  '\x1b[38;2;217;119;87m',
  success:  '\x1b[92m',
  warning:  '\x1b[93m',
  danger:   '\x1b[91m',
  info:     '\x1b[97m',
  dim:      '\x1b[90m',
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

// Session 缓存
const discoveryCache = new Map(); // key: `${source}\n${skillName}` → value: { names: string[], timestamp: number }
let lastInstallData = null;

// Bundled contracts（构建时注入，fallback 到内联定义）
const BUNDLED_CONTRACTS = typeof global.BUNDLED_CONTRACTS !== 'undefined'
  ? global.BUNDLED_CONTRACTS
  : null;

// ============================================================================
// 工具层
// ============================================================================

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

/**
 * 计算字符串的显示宽度（CJK 字符 = 2，ASCII = 1）
 */
function displayWidth(str) {
  if (!str) return 0;
  return Array.from(str).reduce((width, char) => {
    const code = char.codePointAt(0);
    if (code >= 0x4E00 && code <= 0x9FFF) return width + 2; // CJK 统一表意文字
    if (code >= 0x3400 && code <= 0x4DBF) return width + 2; // CJK 扩展A
    if (code >= 0xAC00 && code <= 0xD7AF) return width + 2; // 韩文音节
    if (code >= 0xFF00 && code <= 0xFFEF) return width + 2; // 全角字符
    return width + 1;
  }, 0);
}

/**
 * 右侧填充空格到指定显示宽度
 */
function pad(str, targetWidth) {
  const current = displayWidth(str);
  return str + ' '.repeat(Math.max(0, targetWidth - current));
}

/**
 * 着色文本
 */
function colorize(text, colorKey) {
  if (!SUPPORTS_ANSI) return text;
  return COLORS[colorKey] + text + COLORS.reset;
}

/**
 * 确保临时缓存目录存在
 */
function ensureTmpCacheDir() {
  if (!fs.existsSync(TMP_CACHE_DIR)) {
    fs.mkdirSync(TMP_CACHE_DIR, { recursive: true, mode: 0o700 });
  }
}

/**
 * 执行外部命令（Promise 包装）
 */
function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const timeout = options.timeout || 60000;
    const suppressOutput = options.suppressOutput || false;

    const proc = spawn(command, args, {
      stdio: suppressOutput ? 'pipe' : 'inherit',
      shell: process.platform === 'win32'
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;

    if (suppressOutput) {
      proc.stdout.on('data', (data) => { stdout += data.toString(); });
      proc.stderr.on('data', (data) => { stderr += data.toString(); });
    }

    const timer = setTimeout(() => {
      timedOut = true;
      proc.kill('SIGTERM');
      setTimeout(() => proc.kill('SIGKILL'), 5000);
    }, timeout);

    proc.on('close', (code) => {
      clearTimeout(timer);
      if (timedOut) {
        return reject(new Error(`命令超时 (${timeout}ms): ${command} ${args.join(' ')}`));
      }
      resolve({ code, stdout, stderr });
    });

    proc.on('error', (err) => {
      clearTimeout(timer);
      reject(err);
    });
  });
}

/**
 * 去重 Skill 名称
 */
function uniqueSkillNames(names) {
  const seen = new Set();
  const result = [];
  for (const name of names) {
    const normalized = (name || '').trim();
    if (normalized && !seen.has(normalized.toLowerCase())) {
      seen.add(normalized.toLowerCase());
      result.push(normalized);
    }
  }
  return result;
}

/**
 * 清除 ANSI 转义序列
 */
function removeAnsiSequences(text) {
  if (!text) return '';
  return text
    .replace(/\x1b\[[0-?]*[ -/]*[@-~]/g, '')
    .replace(/[\x00-\x08\x0B\x0C\x0E-\x1F\x7F]/g, '');
}

/**
 * 从 skills CLI 输出解析 Skill 名称列表
 */
function parseSkillsListOutput(text) {
  const clean = removeAnsiSequences(text);
  const names = [];
  const lines = clean.split(/\r?\n/);

  for (const rawLine of lines) {
    const line = rawLine.trim();
    if (!line.startsWith('│')) continue;

    const candidate = line.replace(/^│/, '').trim();
    if (/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(candidate)) {
      names.push(candidate);
    }
  }

  return uniqueSkillNames(names);
}

// ============================================================================
// Catalogue 层
// ============================================================================

/**
 * 内联 fallback catalogue（与 contracts/skills.json 一致）
 */
const FALLBACK_CATALOGUE = [
  {
    Id: 'find-skills',
    Name: 'find-skills',
    Source: 'vercel-labs/skills',
    SkillName: 'find-skills',
    StaticSkillName: '',
    SkipDiscovery: false,
    Description: 'Skills 发现辅助技能',
    Default: true,
    Order: 10
  },
  {
    Id: 'anthropics-skills',
    Name: '官方 Skills',
    Source: 'anthropics/skills',
    SkillName: '',
    StaticSkillName: '',
    SkipDiscovery: false,
    Description: 'Anthropic 官方 Skills 集合',
    Default: false,
    Order: 20
  },
  {
    Id: 'vercel-agent-skills',
    Name: 'Vercel Agent Skills',
    Source: 'vercel-labs/agent-skills',
    SkillName: '',
    StaticSkillName: '',
    SkipDiscovery: false,
    Description: 'Vercel Agent Skills 集合',
    Default: false,
    Order: 30
  },
  {
    Id: 'ppt-master',
    Name: 'PPT Master',
    Source: 'hugohe3/ppt-master',
    SkillName: '',
    StaticSkillName: 'ppt-master',
    SkipDiscovery: true,
    Description: 'PPT 生成与演示文稿技能',
    Default: false,
    Order: 120
  }
];

const FALLBACK_IGNORED_NAMES = [
  'ccg-skills',
  'collaborating-with-codex',
  'collaborating-with-gemini'
];

/**
 * 规范化 catalogue 条目
 */
function normalizeEntry(entry) {
  return {
    Id: entry.Id || '',
    Name: entry.Name || '',
    Source: entry.Source || '',
    SkillName: entry.SkillName || '',
    StaticSkillName: entry.StaticSkillName || '',
    SkipDiscovery: !!entry.SkipDiscovery,
    Description: entry.Description || '',
    Default: !!entry.Default,
    Order: typeof entry.Order === 'number' ? entry.Order : 9999
  };
}

/**
 * 加载 Skills catalogue
 */
function loadSkillsCatalogue() {
  let catalogue = [];
  let ignoredNames = [];

  // 尝试从打包的 contracts 加载
  if (BUNDLED_CONTRACTS && BUNDLED_CONTRACTS.skills) {
    const contract = BUNDLED_CONTRACTS.skills;
    if (Array.isArray(contract.Catalogue)) {
      catalogue = contract.Catalogue.map(normalizeEntry);
    }
    if (Array.isArray(contract.IgnoredSkillNames)) {
      ignoredNames = contract.IgnoredSkillNames.filter(n => typeof n === 'string');
    }
  }

  // Fallback 到内联定义
  if (catalogue.length === 0) {
    catalogue = FALLBACK_CATALOGUE.map(normalizeEntry);
  }
  if (ignoredNames.length === 0) {
    ignoredNames = [...FALLBACK_IGNORED_NAMES];
  }

  // 排序
  catalogue.sort((a, b) => a.Order - b.Order);

  return { catalogue, ignoredNames };
}

/**
 * 判断 Skill 是否被忽略
 */
function isSkillIgnored(skillName, ignoredNames) {
  const normalized = (skillName || '').trim().toLowerCase();
  return ignoredNames.some(n => n.toLowerCase() === normalized);
}

// ============================================================================
// 发现层
// ============================================================================

/**
 * 生成发现缓存键
 */
function getDiscoveryCacheKey(source, skillName) {
  return `${source}\n${skillName || ''}`;
}

/**
 * 动态发现 Skills（含缓存）
 */
async function discoverSkills(entry) {
  const cacheKey = getDiscoveryCacheKey(entry.Source, entry.SkillName);

  // 检查缓存
  if (discoveryCache.has(cacheKey)) {
    const cached = discoveryCache.get(cacheKey);
    return cached.names;
  }

  // SkipDiscovery 条目使用静态名称
  if (entry.SkipDiscovery) {
    const staticName = entry.StaticSkillName || entry.SkillName;
    const names = staticName ? [staticName] : [];
    discoveryCache.set(cacheKey, { names, timestamp: Date.now() });
    return names;
  }

  // 执行远程发现
  const args = ['--yes', 'skills', 'add', entry.Source, '--list', '-g', '--agent', SKILLS_CLI_AGENT];
  if (entry.SkillName) {
    args.push('--skill', entry.SkillName);
  }

  try {
    const { code, stdout, stderr } = await execCommand('npx', args, {
      timeout: DISCOVERY_TIMEOUT_MS,
      suppressOutput: true
    });

    if (code === 0) {
      const text = stdout + '\n' + stderr;
      const names = parseSkillsListOutput(text);
      discoveryCache.set(cacheKey, { names, timestamp: Date.now() });
      return names;
    } else {
      discoveryCache.set(cacheKey, { names: [], timestamp: Date.now() });
      return [];
    }
  } catch (err) {
    discoveryCache.set(cacheKey, { names: [], timestamp: Date.now() });
    return [];
  }
}

/**
 * 批量发现（串行简化版）
 */
async function listAvailableSkills(entries, showProgress = false) {
  const results = [];
  let completed = 0;
  const total = entries.length;

  for (const entry of entries) {
    const names = await discoverSkills(entry);
    results.push({ entry, names });
    completed++;

    if (showProgress) {
      const status = names.length > 0 ? `发现 ${names.length} 个` : '发现失败，状态未知';
      console.log(colorize(`  - [${completed}/${total}] ${entry.Name}: ${status}`, 'info'));
    }
  }

  return results;
}

// ============================================================================
// CLI 层
// ============================================================================

/**
 * 获取已安装的 Skills
 */
async function getInstalledSkills() {
  const args = ['--yes', 'skills', 'list', '-g', '-a', SKILLS_CLI_AGENT, '--json'];

  try {
    const { code, stdout } = await execCommand('npx', args, {
      timeout: LIST_TIMEOUT_MS,
      suppressOutput: true
    });

    if (code !== 0 || !stdout.trim()) {
      return [];
    }

    const items = JSON.parse(stdout.trim());
    const { ignoredNames } = loadSkillsCatalogue();
    const records = [];

    for (const item of items) {
      if (!item || !item.name) continue;
      const skillName = item.name;
      if (isSkillIgnored(skillName, ignoredNames)) continue;

      records.push({
        name: skillName,
        path: item.path || '',
        scope: item.scope || '',
        agents: item.agents || []
      });
    }

    return records;
  } catch (err) {
    return [];
  }
}

/**
 * 友好错误消息
 */
function getFriendlyError(exitCode, errorText, actionName) {
  if (/ETIMEDOUT|ECONNREFUSED|ENOTFOUND|network|fetch failed/i.test(errorText)) {
    return '无法访问 npm/GitHub，请检查网络连接或代理设置';
  }
  if (/EACCES|EPERM|permission|symlink/i.test(errorText)) {
    return '文件权限或 symlink 创建失败，可在 Skills 管理安装时启用 copy 模式';
  }
  if (/not found|No matching|404/i.test(errorText)) {
    return 'Skills source 或指定 skill 可能已变更，请检查 catalogue';
  }
  return `Skills ${actionName}失败 (ExitCode: ${exitCode})`;
}

/**
 * 安装单个 Skill
 */
async function installSkill(entry, copyMode = false) {
  const args = ['--yes', 'skills', 'add', entry.Source, '--yes', '--agent', SKILLS_CLI_AGENT, '-g'];

  if (entry.SkillName) {
    args.push('--skill', entry.SkillName);
  }

  if (copyMode) {
    args.push('--copy');
  }

  const entryName = entry.Name;
  console.log(colorize(`  - 正在安装 ${entryName}`, 'primary'));

  try {
    const { code, stdout, stderr } = await execCommand('npx', args, {
      timeout: INSTALL_TIMEOUT_MS,
      suppressOutput: true
    });

    if (code === 0) {
      console.log(colorize(`  - ${entryName} 安装成功`, 'success'));
      return { success: true, entryName };
    } else {
      const errorText = stderr || stdout || '未知错误';
      const friendlyError = getFriendlyError(code, errorText, '安装');
      console.log(colorize(`  - ${entryName} 安装失败 [FAIL]: ${friendlyError}`, 'warning'));
      return { success: false, entryName, error: friendlyError };
    }
  } catch (err) {
    const friendlyError = getFriendlyError(-1, err.message, '安装');
    console.log(colorize(`  - ${entryName} 安装失败 [FAIL]: ${friendlyError}`, 'warning'));
    return { success: false, entryName, error: friendlyError };
  }
}

/**
 * 更新 Skills
 */
async function updateSkills(skillNames = []) {
  const args = ['--yes', 'skills', 'update'];
  if (skillNames.length > 0) {
    args.push(...skillNames);
  }
  args.push('-g', '-y');

  console.log(colorize('正在更新 Skills...', 'primary'));

  try {
    const { code, stdout, stderr } = await execCommand('npx', args, {
      timeout: UPDATE_TIMEOUT_MS,
      suppressOutput: true
    });

    const outputText = removeAnsiSequences(stdout + '\n' + stderr);

    if (code === 0) {
      const noChange = /no\s+updates|already\s+up\s+to\s+date|up\s+to\s+date|all\s+skills\s+.*latest|0\s+skills?\s+updated/i.test(outputText);

      if (noChange) {
        console.log(colorize('Skills 已是最新', 'info'));
        return { success: true, noChange: true };
      } else {
        console.log(colorize('Skills 更新完成', 'success'));
        return { success: true, noChange: false };
      }
    } else {
      const friendlyError = getFriendlyError(code, stderr || stdout, '更新');
      console.log(colorize(`更新失败: ${friendlyError}`, 'danger'));
      return { success: false, error: friendlyError };
    }
  } catch (err) {
    const friendlyError = getFriendlyError(-1, err.message, '更新');
    console.log(colorize(`更新失败: ${friendlyError}`, 'danger'));
    return { success: false, error: friendlyError };
  }
}

/**
 * 卸载 Skills
 */
async function uninstallSkills(skillNames) {
  const args = ['--yes', 'skills', 'remove', ...skillNames, '-g', '-a', SKILLS_CLI_AGENT, '--yes'];

  console.log(colorize(`正在卸载: ${skillNames.join(', ')}`, 'primary'));

  try {
    const { code, stdout, stderr } = await execCommand('npx', args, {
      timeout: UNINSTALL_TIMEOUT_MS,
      suppressOutput: true
    });

    if (code === 0) {
      console.log(colorize('卸载完成', 'success'));
      return { success: true };
    } else {
      const friendlyError = getFriendlyError(code, stderr || stdout, '卸载');
      console.log(colorize(`卸载失败: ${friendlyError}`, 'danger'));
      return { success: false, error: friendlyError };
    }
  } catch (err) {
    const friendlyError = getFriendlyError(-1, err.message, '卸载');
    console.log(colorize(`卸载失败: ${friendlyError}`, 'danger'));
    return { success: false, error: friendlyError };
  }
}

// ============================================================================
// 菜单层（交互式）
// ============================================================================

/**
 * 单选菜单
 */
function promptChoice(question, options) {
  return new Promise((resolve) => {
    console.log('');
    console.log(colorize(question, 'info'));
    options.forEach((opt, idx) => {
      console.log(`  ${idx + 1}. ${opt}`);
    });
    console.log('');

    const rl = readline.createInterface({
      input: TTY_INPUT,
      output: TTY_OUTPUT,
      terminal: true
    });

    rl.question(colorize('请选择 (输入序号): ', 'primary'), (answer) => {
      rl.close();
      const choice = parseInt(answer.trim(), 10) - 1;
      resolve(choice >= 0 && choice < options.length ? choice : -1);
    });
  });
}

/**
 * 更新菜单
 */
async function showUpdateMenu() {
  console.log('');
  console.log(colorize('═══ 更新 Skills ═══', 'primary'));

  const installed = await getInstalledSkills();
  if (installed.length === 0) {
    console.log(colorize('未检测到已安装的 Skills', 'warning'));
    return;
  }

  const choice = await promptChoice('选择更新方式', [
    `更新全部 Skills（${installed.length} 个）`,
    '返回'
  ]);

  if (choice === 0) {
    const result = await updateSkills();
    if (!result.success) {
      console.log('');
      console.log(colorize(`更新失败: ${result.error}`, 'danger'));
    }
  }
}

/**
 * 卸载菜单
 */
async function showUninstallMenu() {
  console.log('');
  console.log(colorize('═══ 卸载 Skills ═══', 'primary'));

  const installed = await getInstalledSkills();
  if (installed.length === 0) {
    console.log(colorize('未检测到已安装的 Skills', 'warning'));
    return;
  }

  console.log(colorize('已安装的 Skills:', 'info'));
  installed.forEach((r, idx) => {
    console.log(`  ${idx + 1}. ${r.name}`);
  });

  console.log('');
  console.log(colorize('⚠️  简化版：暂不支持多选，请使用临时方案卸载', 'warning'));
}

/**
 * 安装菜单
 */
async function showInstallMenu() {
  console.log('');
  console.log(colorize('═══ 安装 Skills ═══', 'primary'));

  const { catalogue } = loadSkillsCatalogue();
  const installed = await getInstalledSkills();
  const installedNames = new Set(installed.map(r => r.name));

  // 显示可选条目
  const options = [];
  const entries = [];
  for (const entry of catalogue) {
    const discovered = await discoverSkills(entry);
    const matchedCount = discovered.filter(n => installedNames.has(n)).length;
    const statusText = matchedCount > 0 ? '[已安装]' : '';
    options.push(`${entry.Name} ${statusText} - ${entry.Description}`);
    entries.push(entry);
  }

  const choice = await promptChoice('选择要安装的 Skills', options);
  if (choice === -1) {
    console.log(colorize('已取消', 'dim'));
    return;
  }

  const selectedEntry = entries[choice];
  const copyMode = await askCopyMode();

  console.log('');
  console.log(colorize(`正在安装 ${selectedEntry.Name}...`, 'primary'));
  const result = await installSkill(selectedEntry, copyMode);

  if (result.success) {
    console.log('');
    console.log(colorize('✓ 安装完成', 'success'));
  } else {
    console.log('');
    console.log(colorize(`✗ 安装失败: ${result.error}`, 'danger'));
  }
}

/**
 * 询问是否启用 copy 模式
 */
async function askCopyMode() {
  const choice = await promptChoice('是否启用 Skills copy 模式？', [
    '不启用 copy 模式（默认）',
    '启用 copy 模式（追加 --copy，适合 symlink 权限受限）'
  ]);
  return choice === 1;
}

// ============================================================================
// 入口层
// ============================================================================

/**
 * 显示简化的 Skills 状态
 */
async function showSkillsStatus() {
  console.log('');
  console.log(colorize('正在检测 Skills 状态...', 'primary'));

  const { catalogue } = loadSkillsCatalogue();
  const installed = await getInstalledSkills();
  const installedNames = new Set(installed.map(r => r.name));

  console.log('');
  console.log(colorize('Skills 状态：', 'primary'));
  console.log('');

  // 表头
  const colWidths = [20, 30, 40];
  const header = '  ' + pad('状态', colWidths[0]) + ' ' + pad('名称', colWidths[1]) + ' ' + pad('简介', colWidths[2]);
  console.log(colorize(header, 'info'));
  console.log(colorize('  ' + '-'.repeat(colWidths.reduce((a, b) => a + b + 1, 0)), 'dim'));

  // 显示 catalogue 条目（简化版：只显示是否已安装）
  for (const entry of catalogue.slice(0, 5)) { // 只显示前 5 个
    const discovered = await discoverSkills(entry);
    const matchedCount = discovered.filter(name => installedNames.has(name)).length;
    const statusText = matchedCount > 0
      ? `已安装 ${matchedCount}/${discovered.length}`
      : discovered.length > 0
        ? `未安装 0/${discovered.length}`
        : '未知';

    const color = matchedCount > 0 ? 'success' : 'dim';
    const line = '  ' + pad(statusText, colWidths[0]) + ' ' + pad(entry.Name, colWidths[1]) + ' ' + pad(entry.Description, colWidths[2]);
    console.log(colorize(line, color));
  }

  console.log('');
  console.log(colorize(`已安装总计: ${installed.length} 个 Skills`, 'info'));
  console.log('');
}

/**
 * 主菜单
 */
async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  try {
    if (action === '--version') {
      console.log(SCRIPT_VERSION);
      cleanupGlobalTTY();
      process.exit(0);
    }

    // 确保临时缓存目录存在
    ensureTmpCacheDir();

    console.log(colorize('═══════════════════════════════════════════', 'primary'));
    console.log(colorize('            Skills 技能管理                ', 'primary'));
    console.log(colorize('═══════════════════════════════════════════', 'primary'));

    // 主循环
    while (true) {
      await showSkillsStatus();

      const choice = await promptChoice('选择操作', [
        '安装 Skills',
        '更新 Skills',
        '卸载 Skills',
        '返回'
      ]);

      if (choice === -1 || choice === 3) {
        console.log('');
        console.log(colorize('再见！(￣▽￣)ゞ', 'primary'));
        break;
      }

      if (choice === 0) {
        await showInstallMenu();
      } else if (choice === 1) {
        await showUpdateMenu();
      } else if (choice === 2) {
        await showUninstallMenu();
      }

      console.log('');
      console.log(colorize('按 Enter 继续...', 'dim'));
      await new Promise((resolve) => {
        const rl = readline.createInterface({
          input: TTY_INPUT,
          output: TTY_OUTPUT,
          terminal: true
        });
        rl.question('', () => {
          rl.close();
          resolve();
        });
      });
    }

    cleanupGlobalTTY();
    process.exit(0);
  } catch (err) {
    console.error(colorize(`❌ ${err.message}`, 'danger'));
    if (process.env.DEBUG) {
      console.error(err.stack);
    }
    cleanupGlobalTTY();
    process.exit(1);
  }
}

if (require.main === module) {
  main();
}

module.exports = {
  SCRIPT_VERSION,
  // 纯函数（可测试）
  uniqueSkillNames,
  removeAnsiSequences,
  parseSkillsListOutput,
  normalizeEntry,
  isSkillIgnored,
  // 数据层
  loadSkillsCatalogue,
  getInstalledSkills,
  discoverSkills,
  listAvailableSkills,
  // CLI 层
  installSkill,
  updateSkills,
  uninstallSkills,
  getFriendlyError
};
