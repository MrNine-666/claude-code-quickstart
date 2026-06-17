#!/usr/bin/env node
/**
 * Update Manager - 组件更新管理核心
 *
 * 职责：版本检测、快照备份、更新编排、回滚恢复
 * 说明：Release 单文件模式不得假设源码 Manage.ps1/Manage.zsh 存在（HC-15），
 *      因此模板/配置类更新仅安全提示源码模式；npm/CLI 类由 JS 直接处理。
 *
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const { spawn } = require('child_process');
const tty = require('tty');

let shared;
try { shared = require('./manage.js'); } catch (e) { shared = null; }

const atomicWrite = shared?.atomicWrite || function atomicWriteFallback(filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  const tempPath = `${filePath}.tmp.${Date.now()}.${process.pid}`;
  try {
    fs.writeFileSync(tempPath, content, 'utf8');
    fs.renameSync(tempPath, filePath);
  } catch (err) {
    try { fs.unlinkSync(tempPath); } catch (e) { /* 静默 */ }
    throw err;
  }
};
const withProfileLock = shared?.withProfileLock || ((fn) => fn());

const SCRIPT_VERSION = '1.0.0';
const HOME = process.env.HOME || process.env.USERPROFILE || os.homedir();
const CLAUDE_DIR = path.join(HOME, '.claude');
const CCQ_DIR = path.join(HOME, '.ccq');
const SKILLS_DIR = path.join(CLAUDE_DIR, 'skills');
const TMP_CACHE_DIR = path.join(os.tmpdir(), `ccq-cache-${process.getuid?.() || process.pid}`);
const NPM_OUTDATED_CACHE_PATH = path.join(TMP_CACHE_DIR, 'npm-outdated.json');
const SNAPSHOT_DIR = path.join(os.tmpdir(), 'ClaudeEnvInstaller');
const NPM_OUTDATED_CACHE_TTL_MS = 60 * 60 * 1000;

const COLORS = {
  primary: '\x1b[38;2;217;119;87m',
  success: '\x1b[92m',
  warning: '\x1b[93m',
  danger: '\x1b[91m',
  info: '\x1b[97m',
  dim: '\x1b[90m',
  reset: '\x1b[0m'
};

// TTY 状态（W1 收敛，任务 11.2.1）：bundle 模式复用 manage.js 单例 TTY 流，
// 避免每子模块各自 openSync('/dev/tty') 导致 fd 泄漏 + 多重 signal handler；
// 仅独立运行（node update-manager.js）时本地 openSync。
let IS_TTY, TTY_INPUT, TTY_OUTPUT, TTY_OWNS_FD;
if (shared?.tty) {
  ({ IS_TTY, TTY_INPUT, TTY_OUTPUT } = shared.tty);
  TTY_OWNS_FD = false;
} else {
  IS_TTY = false;
  TTY_INPUT = process.stdin;
  TTY_OUTPUT = process.stdout;
  TTY_OWNS_FD = false;
  try {
    const ttyFd = fs.openSync('/dev/tty', 'r+');
    fs.closeSync(ttyFd);
    IS_TTY = true;
    TTY_INPUT = new tty.ReadStream(fs.openSync('/dev/tty', 'r'));
    TTY_OUTPUT = new tty.WriteStream(fs.openSync('/dev/tty', 'w'));
    TTY_OWNS_FD = true;
  } catch (e) {
    IS_TTY = process.stdin.isTTY && process.stdout.isTTY;
  }
}
const SUPPORTS_ANSI = IS_TTY;

function cleanupGlobalTTY() {
  if (!TTY_OWNS_FD || !TTY_INPUT || !TTY_OUTPUT) return;
  try {
    if (TTY_INPUT.isTTY && typeof TTY_INPUT.setRawMode === 'function') TTY_INPUT.setRawMode(false);
    TTY_INPUT.destroy();
    TTY_OUTPUT.destroy();
  } catch (e) { /* 静默 */ }
}

function colorize(text, colorKey) {
  if (!SUPPORTS_ANSI) return text;
  return COLORS[colorKey] + text + COLORS.reset;
}

function displayWidth(str) {
  if (!str) return 0;
  return Array.from(str).reduce((width, char) => {
    const code = char.codePointAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||
        (code >= 0x3000 && code <= 0x303F) ||
        (code >= 0xFF00 && code <= 0xFFEF)) return width + 2;
    return width + 1;
  }, 0);
}

function pad(str, width) {
  const raw = String(str || '');
  return raw + ' '.repeat(Math.max(0, width - displayWidth(raw)));
}

function ensureDir(dirPath) {
  if (!fs.existsSync(dirPath)) fs.mkdirSync(dirPath, { recursive: true, mode: 0o700 });
}

function execCommand(command, args, options = {}) {
  return new Promise((resolve, reject) => {
    const proc = spawn(command, args, {
      cwd: options.cwd || process.cwd(),
      env: options.env || process.env,
      shell: false,
      stdio: options.quiet ? 'pipe' : 'inherit'
    });

    let stdout = '';
    let stderr = '';
    let timedOut = false;
    let timeoutId = null;

    if (options.timeout && options.timeout > 0) {
      timeoutId = setTimeout(() => {
        timedOut = true;
        try { proc.kill('SIGTERM'); } catch (e) { /* 静默 */ }
      }, options.timeout);
    }

    if (options.quiet) {
      proc.stdout?.on('data', (data) => { stdout += data.toString(); });
      proc.stderr?.on('data', (data) => { stderr += data.toString(); });
    }

    proc.on('close', (code) => {
      if (timeoutId) clearTimeout(timeoutId);
      if (timedOut) {
        resolve({ exitCode: 124, stdout, stderr: stderr || `Command timed out after ${options.timeout}ms` });
        return;
      }
      resolve({ exitCode: code || 0, stdout, stderr });
    });
    proc.on('error', (err) => {
      if (timeoutId) clearTimeout(timeoutId);
      reject(err);
    });
  });
}

function sha256File(filePath) {
  if (!fs.existsSync(filePath)) return null;
  return crypto.createHash('sha256').update(fs.readFileSync(filePath)).digest('hex');
}

function readJsonFile(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (e) {
    return fallback;
  }
}

function parseSemver(version) {
  if (!version) return null;
  const normalized = String(version).trim().replace(/^v/i, '');
  const match = normalized.match(/^(\d+)\.(\d+)\.(\d+)(?:-([0-9A-Za-z.-]+))?(?:\+([0-9A-Za-z.-]+))?$/);
  if (!match) return null;
  return {
    major: Number(match[1]),
    minor: Number(match[2]),
    patch: Number(match[3]),
    prerelease: match[4] || null,
    build: match[5] || null
  };
}

function semverCompare(v1, v2) {
  const a = parseSemver(v1);
  const b = parseSemver(v2);
  if (!a || !b) return 0;
  if (a.major !== b.major) return a.major - b.major;
  if (a.minor !== b.minor) return a.minor - b.minor;
  if (a.patch !== b.patch) return a.patch - b.patch;
  if (!a.prerelease && b.prerelease) return 1;
  if (a.prerelease && !b.prerelease) return -1;
  if (a.prerelease && b.prerelease) return a.prerelease.localeCompare(b.prerelease);
  return 0;
}

function hasUpdate(current, latest) {
  if (!current || !latest) return null;
  const latestParsed = parseSemver(latest);
  if (latestParsed?.prerelease) return false;
  return semverCompare(latest, current) > 0;
}

function readNpmOutdatedCache() {
  if (!fs.existsSync(NPM_OUTDATED_CACHE_PATH)) return null;
  try {
    const stat = fs.statSync(NPM_OUTDATED_CACHE_PATH);
    if (Date.now() - stat.mtimeMs > NPM_OUTDATED_CACHE_TTL_MS) return null;
    const cached = JSON.parse(fs.readFileSync(NPM_OUTDATED_CACHE_PATH, 'utf8'));
    if (!cached || typeof cached !== 'object' || Array.isArray(cached)) return null;
    return cached;
  } catch (e) {
    return null;
  }
}

function writeNpmOutdatedCache(outdated) {
  ensureDir(TMP_CACHE_DIR);
  atomicWrite(NPM_OUTDATED_CACHE_PATH, JSON.stringify(outdated || {}, null, 2));
}

async function getNpmOutdatedGlobal(forceRefresh = false) {
  if (!forceRefresh) {
    const cached = readNpmOutdatedCache();
    if (cached) return cached;
  }

  const result = await execCommand('npm', ['outdated', '-g', '--json'], { quiet: true, timeout: 30000 });
  let outdated = {};
  if (result.stdout && result.stdout.trim()) {
    try { outdated = JSON.parse(result.stdout); } catch (e) { outdated = {}; }
  }
  writeNpmOutdatedCache(outdated);
  return outdated;
}

const NPM_COMPONENT_MAP = {
  ClaudeCode: '@anthropic-ai/claude-code',
  Ccline: '@cometix/ccline',
  CcgWorkflow: 'ccg-workflow',
  CodexCli: 'codex-cli',
  OpenSpec: '@fission-ai/openspec'
};

const COMMAND_COMPONENTS = {
  ClaudeCode: { command: 'claude', versionArgs: ['--version'] },
  Ccline: { command: 'ccline', versionArgs: ['--version'] },
  CcgWorkflow: { command: 'codeagent-wrapper', versionArgs: ['--version'] },
  CodexCli: { command: 'codex', versionArgs: ['--version'] },
  OpenSpec: { command: 'openspec', versionArgs: ['--version'] },
  AntigravityCli: { command: 'agy', versionArgs: ['--version'] }
};

const TEMPLATE_COMPONENTS = [
  { id: 'ClaudeMd', name: 'CLAUDE.md 配置', markerPath: path.join(CLAUDE_DIR, 'CLAUDE.md') },
  { id: 'ClaudeConfig', name: 'Claude 基础配置', markerPath: path.join(CLAUDE_DIR, 'settings.json') }
];

async function getCommandVersion(command, args) {
  try {
    const result = await execCommand(command, args, { quiet: true, timeout: 5000 });
    if (result.exitCode !== 0) return { installed: false, version: '' };
    const text = (result.stdout || result.stderr || '').trim();
    const version = (text.match(/\d+\.\d+\.\d+(?:[-+][0-9A-Za-z.-]+)?/) || [text])[0] || '';
    return { installed: true, version };
  } catch (e) {
    return { installed: false, version: '' };
  }
}

async function buildNpmComponentStatus(id, packageName, outdated) {
  const commandInfo = COMMAND_COMPONENTS[id];
  const versionInfo = commandInfo
    ? await getCommandVersion(commandInfo.command, commandInfo.versionArgs)
    : { installed: false, version: '' };
  const remote = outdated[packageName];

  return {
    id,
    name: id,
    type: 'npm',
    package: packageName,
    installed: versionInfo.installed,
    currentVersion: versionInfo.version,
    latestVersion: remote?.latest || versionInfo.version,
    hasUpdate: versionInfo.installed ? (remote ? hasUpdate(versionInfo.version, remote.latest || '') : false) : null
  };
}

async function buildAntigravityStatus() {
  const versionInfo = await getCommandVersion('agy', ['--version']);
  return {
    id: 'AntigravityCli',
    name: 'AntigravityCli',
    type: 'cli',
    installed: versionInfo.installed,
    currentVersion: versionInfo.version,
    latestVersion: '',
    hasUpdate: null,
    statusHint: '无法获取更新状态，执行 agy update 更新'
  };
}

async function checkSkillsUpdates(outdated = null) {
  if (!fs.existsSync(SKILLS_DIR)) return [];
  const globalOutdated = outdated || await getNpmOutdatedGlobal(false);
  const entries = fs.readdirSync(SKILLS_DIR, { withFileTypes: true }).filter((entry) => entry.isDirectory());
  const skills = [];

  for (const entry of entries) {
    const packagePath = path.join(SKILLS_DIR, entry.name, 'package.json');
    const pkg = readJsonFile(packagePath, null);
    if (!pkg) continue;
    const packageName = pkg.name || entry.name;
    const currentVersion = pkg.version || '';
    const remote = globalOutdated[packageName];
    skills.push({
      id: `Skill:${entry.name}`,
      name: entry.name,
      type: 'skill',
      package: packageName,
      installed: true,
      currentVersion,
      latestVersion: remote?.latest || currentVersion,
      hasUpdate: remote ? hasUpdate(currentVersion, remote.latest || '') : false
    });
  }

  return skills;
}

async function checkCliToolUpdates(outdated = null) {
  const globalOutdated = outdated || await getNpmOutdatedGlobal(false);
  const components = [];
  for (const [id, packageName] of Object.entries(NPM_COMPONENT_MAP)) {
    components.push(await buildNpmComponentStatus(id, packageName, globalOutdated));
  }
  components.push(await buildAntigravityStatus());
  return components;
}

function extractNpmPackageFromArgs(args) {
  if (!Array.isArray(args)) return '';
  for (const arg of args) {
    if (typeof arg !== 'string') continue;
    if (arg.startsWith('-')) continue;
    if (arg.includes('://')) continue;
    if (/^(?:@[^/\s]+\/[^@\s]+|[a-z0-9._-]+)(?:@[^\s]+)?$/i.test(arg)) return arg;
  }
  return '';
}

async function checkMcpServerUpdates() {
  const servers = [];
  const seen = new Set();
  const configFiles = [path.join(CLAUDE_DIR, 'settings.json'), path.join(HOME, '.claude.json')];

  for (const configPath of configFiles) {
    const cfg = readJsonFile(configPath, null);
    if (!cfg) continue;
    const candidates = [cfg.mcpServers];
    if (cfg.projects && typeof cfg.projects === 'object') {
      for (const project of Object.values(cfg.projects)) candidates.push(project?.mcpServers);
    }

    for (const mcpServers of candidates) {
      if (!mcpServers || typeof mcpServers !== 'object') continue;
      for (const [name, server] of Object.entries(mcpServers)) {
        const packageName = extractNpmPackageFromArgs(server?.args);
        if (!packageName) continue;
        const key = `${name}:${packageName}`;
        if (seen.has(key)) continue;
        seen.add(key);
        servers.push({
          id: `Mcp:${name}`,
          name: `MCP ${name}`,
          type: 'mcp',
          package: packageName,
          installed: true,
          currentVersion: 'configured',
          latestVersion: '',
          hasUpdate: null,
          statusHint: 'npx/远程 MCP 无稳定本地版本，按 registry 配置展示'
        });
      }
    }
  }

  return servers;
}

function checkTemplateUpdates() {
  return TEMPLATE_COMPONENTS.map((component) => ({
    id: component.id,
    name: component.name,
    type: 'template',
    installed: fs.existsSync(component.markerPath),
    currentVersion: fs.existsSync(component.markerPath) ? 'installed' : '',
    latestVersion: '',
    hasUpdate: null,
    statusHint: '模板/配置类更新请使用源码模式'
  }));
}

async function checkComponentUpdates() {
  console.log('');
  console.log(colorize('正在检测组件状态与远程版本...', 'dim'));
  const outdated = await getNpmOutdatedGlobal(false);
  return [
    ...await checkCliToolUpdates(outdated),
    ...await checkSkillsUpdates(outdated),
    ...await checkMcpServerUpdates(),
    ...checkTemplateUpdates()
  ];
}

function getSnapshotFiles() {
  const files = [
    path.join(CLAUDE_DIR, 'settings.json'),
    path.join(HOME, '.claude.json'),
    path.join(CLAUDE_DIR, 'CLAUDE.md'),
    path.join(CCQ_DIR, 'mcp-meta.json')
  ];

  const rulesDir = path.join(CLAUDE_DIR, 'rules');
  if (fs.existsSync(rulesDir)) {
    for (const file of fs.readdirSync(rulesDir)) {
      if ((file.startsWith('ccq-') || file.startsWith('ccg-')) && file.endsWith('.md')) {
        files.push(path.join(rulesDir, file));
      }
    }
  }

  return files.filter((file) => fs.existsSync(file));
}

function createSnapshot() {
  ensureDir(SNAPSHOT_DIR);
  const timestamp = new Date().toISOString().replace(/[-:]/g, '').split('.')[0];
  const suffix = crypto.randomBytes(4).toString('hex');
  const snapshotPath = path.join(SNAPSHOT_DIR, `update_${timestamp}_${process.pid}_${suffix}`);
  ensureDir(snapshotPath);

  const canaryPath = path.join(snapshotPath, '_canary.tmp');
  fs.writeFileSync(canaryPath, 'canary\n');
  fs.unlinkSync(canaryPath);

  const manifest = { createdAt: new Date().toISOString(), files: [] };
  for (const sourcePath of getSnapshotFiles()) {
    const relative = path.relative(HOME, sourcePath);
    const destPath = path.join(snapshotPath, relative);
    ensureDir(path.dirname(destPath));
    fs.copyFileSync(sourcePath, destPath);
    manifest.files.push({ source: sourcePath, relative, hash: sha256File(sourcePath) });
  }

  atomicWrite(path.join(snapshotPath, 'manifest.json'), JSON.stringify(manifest, null, 2));
  console.error(colorize(`✓ 更新快照已创建: ${snapshotPath} (${manifest.files.length} 个文件)`, 'success'));
  return snapshotPath;
}

function rollbackFromSnapshot(snapshotPath) {
  if (!fs.existsSync(snapshotPath)) throw new Error(`快照不存在: ${snapshotPath}`);
  const manifestPath = path.join(snapshotPath, 'manifest.json');
  const manifest = readJsonFile(manifestPath, null);
  if (!manifest || !Array.isArray(manifest.files)) throw new Error('快照 manifest.json 缺失或损坏');

  for (const fileInfo of manifest.files) {
    const srcPath = path.join(snapshotPath, fileInfo.relative);
    if (!fs.existsSync(srcPath)) throw new Error(`快照文件缺失: ${fileInfo.relative}`);
    if (sha256File(srcPath) !== fileInfo.hash) throw new Error(`快照文件校验失败: ${fileInfo.relative}`);
    ensureDir(path.dirname(fileInfo.source));
    fs.copyFileSync(srcPath, fileInfo.source);
  }

  console.log(colorize(`✓ 已从快照恢复 ${manifest.files.length} 个文件`, 'success'));
}

function clearOldSnapshots(currentSnapshotPath = '', maxSnapshots = 5, daysToKeep = 30) {
  if (!fs.existsSync(SNAPSHOT_DIR)) return;
  const snapshots = fs.readdirSync(SNAPSHOT_DIR)
    .filter((name) => name.startsWith('update_'))
    .map((name) => {
      const fullPath = path.join(SNAPSHOT_DIR, name);
      return { path: fullPath, mtime: fs.statSync(fullPath).mtimeMs };
    })
    .sort((a, b) => b.mtime - a.mtime);

  const cutoff = Date.now() - daysToKeep * 24 * 60 * 60 * 1000;
  let kept = 0;
  for (const snapshot of snapshots) {
    if (snapshot.path === currentSnapshotPath) continue;
    if (kept >= maxSnapshots || snapshot.mtime < cutoff) {
      try { fs.rmSync(snapshot.path, { recursive: true, force: true }); } catch (e) { /* 静默 */ }
    } else {
      kept++;
    }
  }
}

function getSourceModeHint() {
  return process.platform === 'win32'
    ? 'pwsh -File installer/windows/Manage.ps1 -Action Update'
    : 'zsh installer/macos/Manage.zsh --action Update';
}

async function applyUpdates(components) {
  const updatedItems = [];

  for (const component of components) {
    console.log('');
    console.log(colorize(`─── 更新: ${component.name} ───`, 'primary'));

    try {
      if (component.type === 'npm' || component.type === 'skill') {
        const packageSpec = component.latestVersion && component.latestVersion !== component.currentVersion
          ? `${component.package}@${component.latestVersion}`
          : component.package;
        const result = await execCommand('npm', ['install', '-g', packageSpec], { timeout: 120000 });
        if (result.exitCode !== 0) throw new Error(`npm install 失败 (exit ${result.exitCode})`);
        console.log(colorize(`  ✓ ${component.name} 已更新`, 'success'));
        updatedItems.push(`updated::${component.id}::${component.currentVersion || 'none'}->${component.latestVersion || 'latest'}`);
      } else if (component.type === 'cli') {
        console.log(colorize('  无法自动检测远程版本，请运行 agy update', 'warning'));
        updatedItems.push(`noop::${component.id}::manual-update-required`);
      } else if (component.type === 'template') {
        console.log(colorize(`  ${component.name} 属于模板/配置类更新，请使用源码模式执行:`, 'warning'));
        console.log(colorize(`  ${getSourceModeHint()}`, 'dim'));
        updatedItems.push(`noop::${component.id}::source-mode-required`);
      } else if (component.type === 'mcp') {
        console.log(colorize('  MCP Server 通过 npx/远程 registry 解析，无需本地包更新', 'dim'));
        updatedItems.push(`noop::${component.id}::registry-managed`);
      }
    } catch (err) {
      console.error(colorize(`  ✗ 更新失败: ${err.message}`, 'danger'));
      updatedItems.push(`failed::${component.id}::${err.message}`);
    }
  }

  return updatedItems;
}

const MARKER_START = '# >>> Claude Code Quickstart >>>';
const MARKER_END = '# <<< Claude Code Quickstart <<<';

function escapeRegex(str) {
  return str.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function updateProfileMarker(profilePath, newContent) {
  return withProfileLock(() => {
    const current = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
    const markerRegex = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`, 'g');
    const newBlock = `${MARKER_START}\n${newContent}\n${MARKER_END}`;
    const updated = markerRegex.test(current)
      ? current.replace(markerRegex, newBlock)
      : `${current.trimEnd()}\n\n${newBlock}\n`;
    atomicWrite(profilePath, updated);
    return true;
  });
}

function generateUpdateSummary(updatedItems) {
  if (!updatedItems || updatedItems.length === 0) return '✓ All components up to date';
  return updatedItems.map((item) => {
    const parts = String(item).split('::');
    return parts.length >= 3 ? item : `updated::unknown::${item}`;
  }).join('\n');
}

function showUpdateTable(components) {
  const installed = components.filter((component) => component.installed);
  if (installed.length === 0) {
    console.log(colorize('  未发现已安装的可更新组件', 'warning'));
    return;
  }

  console.log('');
  console.log(colorize('可更新组件状态:', 'primary'));
  console.log(colorize('─'.repeat(72), 'dim'));
  console.log(`${pad('组件', 20)} ${pad('状态', 12)} ${pad('当前版本', 18)} ${pad('最新版本', 16)}`);
  console.log(colorize('─'.repeat(72), 'dim'));

  for (const component of installed) {
    let status = '可执行检查';
    let color = 'dim';
    if (component.hasUpdate === true) { status = '有更新'; color = 'warning'; }
    else if (component.hasUpdate === false) { status = '已是最新'; }
    else if (component.statusHint) { status = '需确认'; }

    console.log(
      `${pad(component.name, 20)} ${pad(colorize(status, color), 12)} ` +
      `${pad(component.currentVersion || '-', 18)} ${pad(component.latestVersion || '-', 16)}`
    );
    if (component.statusHint) console.log(colorize(`  ${component.statusHint}`, 'dim'));
  }

  console.log(colorize('─'.repeat(72), 'dim'));
}

async function prompt(question) {
  const rl = readline.createInterface({ input: TTY_INPUT, output: TTY_OUTPUT });
  return new Promise((resolve) => {
    rl.question(question, (answer) => {
      rl.close();
      resolve(answer.trim());
    });
  });
}

async function selectComponents(components) {
  const installed = components.filter((component) => component.installed);
  if (installed.length === 0) return [];

  console.log('');
  console.log(colorize('可更新组件:', 'primary'));
  installed.forEach((component, index) => {
    let hint = '';
    if (component.hasUpdate === true) hint = ` (${component.currentVersion || '-'} -> ${component.latestVersion || 'latest'})`;
    else if (component.hasUpdate === false) hint = component.currentVersion ? ` (已是最新 ${component.currentVersion})` : ' (已是最新)';
    else hint = component.statusHint ? ` (${component.statusHint})` : ' (已安装)';
    console.log(`  ${index + 1}. ${component.name}${colorize(hint, component.hasUpdate === true ? 'warning' : 'dim')}`);
  });

  const defaultIndices = installed
    .map((component, index) => component.hasUpdate !== false ? index + 1 : null)
    .filter(Boolean);
  const answer = await prompt(colorize(`选择要更新的组件（逗号分隔，默认 ${defaultIndices.join(',')}，0 取消）: `, 'primary'));
  if (answer === '0') return [];

  const selected = answer === '' ? defaultIndices : answer.split(',')
    .map((value) => Number(value.trim()))
    .filter((value) => Number.isInteger(value) && value >= 1 && value <= installed.length);
  return Array.from(new Set(selected)).map((index) => installed[index - 1]);
}

async function runListUpdates() {
  const components = await checkComponentUpdates();
  showUpdateTable(components);
  if (components.some((component) => component.installed && component.hasUpdate === true)) {
    console.log('');
    console.log(colorize('提示: 运行管理面板选择并更新组件', 'dim'));
  }
  return 0;
}

async function runApplyUpdates() {
  if (!IS_TTY) throw new Error('更新管理需要交互式终端');

  const components = await checkComponentUpdates();
  showUpdateTable(components);
  const selected = await selectComponents(components);
  if (selected.length === 0) {
    console.log(colorize('未选择任何步骤，退出更新', 'info'));
    return 0;
  }

  console.log('');
  console.log(colorize('更新执行计划:', 'primary'));
  selected.forEach((component, index) => console.log(colorize(`  ${index + 1}. ${component.name} (${component.id})`, 'info')));

  const mutating = selected.filter((component) => component.type === 'npm' || component.type === 'skill');
  const snapshotPath = mutating.length > 0 ? createSnapshot() : '';
  const updatedItems = await applyUpdates(selected);
  if (snapshotPath) clearOldSnapshots(snapshotPath);

  console.log('');
  console.log(colorize('══════════════════════════════════════════', 'primary'));
  console.log(colorize('  更新结果摘要', 'primary'));
  console.log(colorize('══════════════════════════════════════════', 'primary'));
  console.log(generateUpdateSummary(updatedItems));
  if (snapshotPath) console.log(colorize(`备份路径: ${snapshotPath}`, 'dim'));
  console.log(colorize('══════════════════════════════════════════', 'primary'));

  return updatedItems.some((item) => item.startsWith('failed::')) ? 1 : 0;
}

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  try {
    if (action === '--version') {
      console.log(SCRIPT_VERSION);
      process.exit(0);
    }
    if (action === '--list-updates' || action === 'list-updates') {
      process.exit(await runListUpdates());
    }
    if (action === '--rollback' || action === 'rollback') {
      const snapshotPath = args[1];
      if (!snapshotPath) throw new Error('请提供快照路径: update-manager.js --rollback <snapshotPath>');
      rollbackFromSnapshot(snapshotPath);
      process.exit(0);
    }

    console.log(colorize('═══════════════════════════════════════════', 'primary'));
    console.log(colorize('            Update 组件更新                ', 'primary'));
    console.log(colorize('═══════════════════════════════════════════', 'primary'));
    process.exit(await runApplyUpdates());
  } catch (err) {
    console.error(colorize(`❌ ${err.message}`, 'danger'));
    process.exit(1);
  } finally {
    cleanupGlobalTTY();
  }
}

// 退出清理与入口：仅独立 CLI 运行时注册（W1 收敛），bundle 模式由 manage.js 统一注册
if (require.main === module) {
  process.on('exit', cleanupGlobalTTY);
  process.on('SIGINT', () => { cleanupGlobalTTY(); process.exit(130); });
  process.on('SIGTERM', () => { cleanupGlobalTTY(); process.exit(143); });
  main();
}

/**
 * 交互式入口函数（供 manage.js 单文件 bundle 调用）
 *
 * 复用 runApplyUpdates() 的交互逻辑，但通过函数调用而非子进程启动。
 * 不调用 process.exit，让控制权返回 manage.js。
 */
async function runInteractive() {
  try {
    console.log(colorize('═══════════════════════════════════════════', 'primary'));
    console.log(colorize('            Update 组件更新                ', 'primary'));
    console.log(colorize('═══════════════════════════════════════════', 'primary'));
    await runApplyUpdates();
    cleanupGlobalTTY();
  } catch (err) {
    console.error(colorize(`❌ ${err.message}`, 'danger'));
    cleanupGlobalTTY();
    throw err;
  }
}

module.exports = {
  SCRIPT_VERSION,
  runInteractive,
  NPM_OUTDATED_CACHE_TTL_MS,
  parseSemver,
  semverCompare,
  hasUpdate,
  readNpmOutdatedCache,
  writeNpmOutdatedCache,
  getNpmOutdatedGlobal,
  checkSkillsUpdates,
  checkCliToolUpdates,
  checkMcpServerUpdates,
  checkComponentUpdates,
  createSnapshot,
  rollbackFromSnapshot,
  updateProfileMarker,
  generateUpdateSummary,
  applyUpdates,
  execCommand
};
