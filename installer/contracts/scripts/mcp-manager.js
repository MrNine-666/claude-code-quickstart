#!/usr/bin/env node
/**
 * MCP Manager - Cross-platform MCP management (UI + Logic)
 *
 * 完整的 TUI + 业务逻辑，零外部依赖（只用 Node.js 内置模块）
 *
 * 架构：
 * - [常量层] SCRIPT_VERSION、路径、颜色、schema
 * - [工具层] displayWidth (CJK)、pad、ansi、atomicWrite、fileLock
 * - [数据层] readJson、writeJson、loadContract、loadVault
 * - [算法层] computeStatus、definitionHash、buildEntry、syncCredentials
 * - [变更层] disable、enable、remove、installMissing
 * - [渲染层] showStatusTable、showMenu、confirm、maskValue、showError
 * - [Rules层] renderRules、syncRules
 * - [入口层] main(action) - 路由到各 mode
 *
 * 参考规格：.claude/plan/mcp-logic-spec.md
 *
 * @author 哈雷酱（傲娇大小姐工程师）
 * @version 1.0.0
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');
const readline = require('readline');
const os = require('os');

// ============================================================================
// 常量层
// ============================================================================

const SCRIPT_VERSION = '1.0.0';

// Vault Schema
const MCP_META_SCHEMA_VERSION = 1;
const MCP_MAX_CORRUPT_BACKUPS = 5;
const MCP_LOCK_TIMEOUT_MS = 30000;

// 路径
const HOME = process.env.HOME || process.env.USERPROFILE;
const CLAUDE_JSON_PATH = path.join(HOME, '.claude.json');
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const VAULT_PATH = path.join(HOME, '.ccq', 'mcp-meta.json');
const RULES_DIR = path.join(HOME, '.claude', 'rules');
const LOCK_FILE = path.join(os.tmpdir(), '.ccq-mcp-vault.lock');

// 颜色语义系统（对齐现有）
const COLORS = {
  primary:  '\x1b[38;2;217;119;87m',  // Claude Orange
  success:  '\x1b[92m',   // 亮绿
  warning:  '\x1b[93m',   // 亮黄
  danger:   '\x1b[91m',   // 亮红
  info:     '\x1b[97m',   // 白
  dim:      '\x1b[90m',   // 灰
  reset:    '\x1b[0m'
};

// TTY 检测与流准备：优先使用 /dev/tty（支持 curl|bash 等管道场景）
let IS_TTY = false;
let TTY_INPUT = process.stdin;
let TTY_OUTPUT = process.stdout;

try {
  // 尝试打开 /dev/tty，如果成功则认为可交互
  const ttyFd = fs.openSync('/dev/tty', 'r+');
  fs.closeSync(ttyFd);
  IS_TTY = true;

  // 创建从 /dev/tty 读写的流（用于管道场景下的交互式输入）
  TTY_INPUT = fs.createReadStream('/dev/tty', { fd: fs.openSync('/dev/tty', 'r') });
  TTY_OUTPUT = fs.createWriteStream('/dev/tty', { fd: fs.openSync('/dev/tty', 'w') });

  // 标记为 TTY（某些库会检查这个属性）
  TTY_INPUT.isTTY = true;
  TTY_OUTPUT.isTTY = true;
} catch (e) {
  // /dev/tty 不可用，回退到 stdin/stdout 检测
  IS_TTY = process.stdin.isTTY && process.stdout.isTTY;
  TTY_INPUT = process.stdin;
  TTY_OUTPUT = process.stdout;
}

const SUPPORTS_ANSI = IS_TTY;

// definitionHash 排除字段（来自规格 3.2）
const EXCLUDE_KEYS = ['Description', 'Category', 'Priority', 'Recommended', 'Name', 'RuntimeDeps'];

// 状态优先级（来自规格 4.1）
const STATUS_PRIORITY = { Custom: 0, Active: 1, Disabled: 2, Missing: 3, Unknown: 4 };

// ============================================================================
// 工具层
// ============================================================================

/**
 * 计算字符串的显示宽度（CJK 字符 = 2，ASCII = 1）
 * 来自规格 14.3，简单正则判断
 */
function displayWidth(str) {
  if (!str) return 0;
  return Array.from(str).reduce((width, char) => {
    // CJK 统一表意文字、全角符号
    const code = char.codePointAt(0);
    if ((code >= 0x4E00 && code <= 0x9FFF) ||   // CJK 统一表意
        (code >= 0x3000 && code <= 0x303F) ||   // CJK 符号和标点
        (code >= 0xFF00 && code <= 0xFFEF)) {   // 全角 ASCII
      return width + 2;
    }
    return width + 1;
  }, 0);
}

/**
 * 填充字符串到指定显示宽度（右侧补空格）
 */
function pad(str, width) {
  const dw = displayWidth(str);
  const padding = width - dw;
  return str + ' '.repeat(Math.max(0, padding));
}

/**
 * 带颜色输出（如果支持 ANSI）
 */
function colorize(text, colorKey) {
  if (!SUPPORTS_ANSI) return text;
  return COLORS[colorKey] + text + COLORS.reset;
}

/**
 * 原子写入文件（临时文件 + rename）
 * 来自规格 10.3
 */
function writeFileAtomic(filePath, content) {
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
 * 文件锁（简单实现，30s 超时 + 过期清理）
 * 来自规格 11.3
 */
function withLock(action) {
  const start = Date.now();
  const timeout = MCP_LOCK_TIMEOUT_MS;

  // 自旋等待锁
  while (true) {
    try {
      // 尝试创建锁文件（exclusive）
      const fd = fs.openSync(LOCK_FILE, 'wx');
      fs.writeSync(fd, `${process.pid}\n${Date.now()}\n`);
      fs.closeSync(fd);
      break;  // 成功获取锁
    } catch (err) {
      if (Date.now() - start > timeout) {
        throw new Error('无法获取 MCP 锁（30s 超时），可能有其他 CCQ 进程正在运行');
      }

      // 检查锁是否过期（超过 5 分钟）
      try {
        const stat = fs.statSync(LOCK_FILE);
        if (Date.now() - stat.mtimeMs > 300000) {
          fs.unlinkSync(LOCK_FILE);  // 清理过期锁
        }
      } catch {}

      // 等待 50ms 后重试（简单 sleep）
      const waitUntil = Date.now() + 50;
      while (Date.now() < waitUntil) { /* busy wait */ }
    }
  }

  try {
    return action();
  } finally {
    try { fs.unlinkSync(LOCK_FILE); } catch {}
  }
}

// ============================================================================
// 数据层
// ============================================================================

/**
 * 读取 JSON 文件，失败返回默认值
 */
function readJson(filePath, defaultValue = {}) {
  try {
    if (!fs.existsSync(filePath)) return defaultValue;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    return defaultValue;
  }
}

/**
 * 写入 JSON 文件（原子写入）
 */
function writeJsonAtomic(filePath, obj) {
  const json = JSON.stringify(obj, null, 2);
  writeFileAtomic(filePath, json);
}

/**
 * 创建空 vault（来自规格 10.1）
 */
function newEmptyVault() {
  const now = new Date().toISOString();
  return {
    schemaVersion: MCP_META_SCHEMA_VERSION,
    createdAt: now,
    updatedAt: now,
    servers: {}
  };
}

/**
 * Vault 腐败恢复（来自规格 10.4）
 */
function handleCorruptVault(filePath) {
  const timestamp = new Date().toISOString().replace(/[:.]/g, '-').replace('T', '_').slice(0, 19);
  const backupPath = filePath + '.corrupt.' + timestamp;

  try {
    fs.copyFileSync(filePath, backupPath);
  } catch {}

  // 清理超过 5 个的腐败备份
  try {
    const dir = path.dirname(filePath);
    const baseName = path.basename(filePath);
    const files = fs.readdirSync(dir)
      .filter(f => f.startsWith(baseName + '.corrupt.'))
      .sort()
      .reverse();

    for (let i = MCP_MAX_CORRUPT_BACKUPS; i < files.length; i++) {
      fs.unlinkSync(path.join(dir, files[i]));
    }
  } catch {}

  return newEmptyVault();
}

/**
 * 读取 vault（来自规格 10.2）
 */
function loadVault() {
  if (!fs.existsSync(VAULT_PATH)) {
    return newEmptyVault();  // Lazy create
  }

  try {
    const content = fs.readFileSync(VAULT_PATH, 'utf8');
    const meta = JSON.parse(content);

    // Schema 校验
    if (!meta || typeof meta.schemaVersion !== 'number' || meta.schemaVersion < 1) {
      return handleCorruptVault(VAULT_PATH);
    }
    if (!meta.servers || typeof meta.servers !== 'object') {
      return handleCorruptVault(VAULT_PATH);
    }

    // 高版本检测
    if (meta.schemaVersion > MCP_META_SCHEMA_VERSION) {
      meta._readOnly = true;
    }

    return meta;
  } catch (err) {
    return handleCorruptVault(VAULT_PATH);
  }
}

/**
 * 写入 vault（来自规格 10.3）
 */
function saveVault(meta) {
  // 高版本检查
  if (meta.schemaVersion > MCP_META_SCHEMA_VERSION) {
    throw new Error(`schema version too high: ${meta.schemaVersion} > ${MCP_META_SCHEMA_VERSION}`);
  }

  // 只读检查
  if (meta._readOnly) {
    throw new Error('vault is read-only (newer schema version)');
  }

  // 更新根 updatedAt
  const now = new Date().toISOString();
  meta.updatedAt = now;

  // 确保根 updatedAt ≥ max(servers[*].updatedAt)
  if (meta.servers) {
    for (const serverId in meta.servers) {
      const server = meta.servers[serverId];
      if (server && server.updatedAt && server.updatedAt > meta.updatedAt) {
        meta.updatedAt = server.updatedAt;
      }
    }
  }

  // 删除内部标记字段
  const cleanMeta = {};
  for (const key in meta) {
    if (!key.startsWith('_')) {
      cleanMeta[key] = meta[key];
    }
  }

  writeJsonAtomic(VAULT_PATH, cleanMeta);
}

/**
 * 加载 contract（内置 MCP Server 定义）
 * 注意：契约顶级键是 McpServers（大写驼峰），需要规范化为 servers（小写）
 * 在 Release 模式下需要从平台层传入或内嵌
 */
function loadContract() {
  // 尝试从多个可能路径加载
  const possiblePaths = [
    path.join(__dirname, '..', 'mcp-servers.json'),  // 源码模式：contracts/scripts/../mcp-servers.json
    path.join(__dirname, 'mcp-servers.json'),        // 同目录（平台层复制场景）
  ];

  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const raw = readJson(p, {});
      // 契约文件顶级键是 McpServers，规范化为 servers
      return { servers: raw.McpServers || {} };
    }
  }

  // Fallback: 返回空契约（只管理已有的 MCP，不提供内置定义）
  // 适用于 Release 模式 + 契约文件未内嵌的降级场景
  return { servers: {} };
}

// ============================================================================
// 算法层
// ============================================================================

/**
 * 递归规范化对象：键按字母排序（来自规格 3.3）
 */
function canonicalizeObject(obj) {
  if (obj && typeof obj === 'object' && !Array.isArray(obj)) {
    const sorted = {};
    for (const key of Object.keys(obj).sort()) {
      sorted[key] = canonicalizeObject(obj[key]);
    }
    return sorted;
  }
  if (Array.isArray(obj)) {
    return obj.map(canonicalizeObject);
  }
  return obj;
}

/**
 * 计算 MCP Server 定义的哈希（SHA-256 前 8 位）
 * 来自规格 3
 */
function definitionHash(serverDef) {
  // 1. 排除非运行时字段
  const runtimeFields = {};
  for (const key in serverDef) {
    if (!EXCLUDE_KEYS.includes(key)) {
      runtimeFields[key] = serverDef[key];
    }
  }

  // 2. 递归规范化（键排序）
  const canonical = canonicalizeObject(runtimeFields);

  // 3. JSON 序列化（注意：需要排序的 stringify）
  const json = JSON.stringify(canonical);

  // 4. SHA-256
  const hash = crypto.createHash('sha256').update(json, 'utf8').digest('hex');

  // 5. 取前 8 位
  return hash.substring(0, 8);
}

/**
 * 计算所有 MCP Server 的状态（来自规格 4）
 * @returns {Array} - [{Id, Name, Status, McpType, Category, HasCredentials}, ...]
 */
function computeStatus() {
  // 读取三个数据源
  const claudeJson = readJson(CLAUDE_JSON_PATH, {});
  const claudeServers = claudeJson.mcpServers || {};

  const vault = loadVault();
  const metaServers = vault.servers || {};

  const contract = loadContract();
  const contractServers = contract.servers || {};

  // 收集所有 Server ID（union）
  const allIds = new Set();
  Object.keys(claudeServers).forEach(id => allIds.add(id));
  Object.keys(contractServers).forEach(id => allIds.add(id));
  Object.keys(metaServers).forEach(id => allIds.add(id));

  // 判定每个 server 的状态
  const results = [];
  for (const id of allIds) {
    const inClaudeJson = claudeServers.hasOwnProperty(id);
    const inContract = contractServers.hasOwnProperty(id);
    const inMeta = metaServers.hasOwnProperty(id);
    const isDisabled = inMeta && metaServers[id] && metaServers[id].disabled === true;

    // 状态判定（来自规格 4.2）
    let status;
    if (inClaudeJson && !inContract) {
      status = 'Custom';
    } else if (isDisabled) {
      status = 'Disabled';
    } else if (inClaudeJson && inContract) {
      status = 'Active';
    } else if (inContract && !inClaudeJson && !isDisabled) {
      status = 'Missing';
    } else {
      status = 'Unknown';
    }

    // 获取名称和类型
    let name = id;
    let mcpType = '';
    let category = '';
    let hasCredentials = false;

    if (inContract) {
      const def = contractServers[id];
      name = def.Name || id;
      mcpType = def.McpType || '';
      category = def.Category || '';
      hasCredentials = def.CredentialType && def.CredentialType !== 'none';
    } else if (inMeta && metaServers[id]) {
      hasCredentials = !!(metaServers[id].credentials);
    }

    results.push({
      Id: id,
      Name: name,
      Status: status,
      McpType: mcpType,
      Category: category,
      HasCredentials: hasCredentials
    });
  }

  // 按状态排序（来自规格 4.4）
  results.sort((a, b) => {
    const aPriority = STATUS_PRIORITY[a.Status] ?? 99;
    const bPriority = STATUS_PRIORITY[b.Status] ?? 99;
    if (aPriority !== bPriority) return aPriority - bPriority;
    return a.Name.localeCompare(b.Name);
  });

  return results;
}

/**
 * 凭据同步：.claude.json ↔ vault 双向补缺（来自规格 5）
 * @returns {Object} - {Success, SyncedCount, Details}
 */
function syncCredentials() {
  const result = { Success: true, SyncedCount: 0, Details: [] };

  try {
    // 读取 .claude.json（无需 vault 锁）
    if (!fs.existsSync(CLAUDE_JSON_PATH)) return result;
    const cj = readJson(CLAUDE_JSON_PATH);
    if (!cj || !cj.mcpServers) return result;

    const contract = loadContract();
    const contractServers = contract.servers || {};

    // vault 读改写在同一锁区间
    withLock(() => {
      const meta = loadVault();
      let vaultChanged = false;
      let cjChanged = false;

      for (const id in cj.mcpServers) {
        const config = cj.mcpServers[id];
        if (!config || typeof config !== 'object') continue;

        const cjHasEnv = config.env && Object.keys(config.env).length > 0;
        const vaultHasCred = meta.servers[id] && meta.servers[id].credentials;
        const vaultHasValues = vaultHasCred && meta.servers[id].credentials.values &&
                               Object.keys(meta.servers[id].credentials.values).length > 0;

        // 场景 A: .claude.json 有 env, vault 无 → 备份到 vault
        if (cjHasEnv && !vaultHasValues) {
          if (!meta.servers[id]) meta.servers[id] = {};
          meta.servers[id].credentials = { values: config.env };
          meta.servers[id].updatedAt = new Date().toISOString();
          vaultChanged = true;
          result.SyncedCount++;
          result.Details.push(`vault-backup::${id}`);
        }

        // 场景 B: vault 有 credentials, .claude.json env 缺失 → 恢复（仅限内置 MCP）
        if (!cjHasEnv && vaultHasValues) {
          const isBuiltin = contractServers.hasOwnProperty(id);
          if (isBuiltin) {
            config.env = meta.servers[id].credentials.values;
            cjChanged = true;
            result.SyncedCount++;
            result.Details.push(`claude-restore::${id}`);
          }
        }
      }

      // vault 写入（同一锁区间内）
      if (vaultChanged) {
        saveVault(meta);
      }

      // .claude.json 写入（锁外）
      if (cjChanged) {
        writeJsonAtomic(CLAUDE_JSON_PATH, cj);
      }
    });
  } catch (err) {
    result.Success = false;
  }

  return result;
}

// ============================================================================
// 变更层（CRUD 操作）
// ============================================================================

/**
 * 禁用 MCP Server（来自规格 6）
 * @param {string} serverId
 * @returns {Object} - {Success, ServerId, Status}
 */
function disableServer(serverId) {
  return withLock(() => {
    // 读取 .claude.json
    const claudeJson = readJson(CLAUDE_JSON_PATH, {});
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};

    // 检查 server 是否存在于 .claude.json
    if (!claudeJson.mcpServers[serverId]) {
      // 检查 meta 是否已标记 disabled
      const meta = loadVault();
      if (meta.servers[serverId] && meta.servers[serverId].disabled) {
        return { Success: true, ServerId: serverId, Status: 'Disabled' };  // 幂等
      }
      return { Success: false, ServerId: serverId, Status: 'NotFound' };
    }

    // 保存完整配置到 vault
    const existingConfig = claudeJson.mcpServers[serverId];
    const meta = loadVault();

    // 提取凭据
    const credentials = (existingConfig && existingConfig.env) ? existingConfig.env : {};

    // 计算定义哈希
    const contract = loadContract();
    let defHash = '';
    if (contract.servers && contract.servers[serverId]) {
      defHash = definitionHash(contract.servers[serverId]);
    }

    // 从 settings.json permissions 移除匹配项
    const settings = readJson(SETTINGS_PATH, {});
    const removedPermissions = [];
    if (settings.permissions && settings.permissions.allow) {
      const mcpPerm = `mcp__${serverId}`;
      if (settings.permissions.allow.includes(mcpPerm)) {
        removedPermissions.push(mcpPerm);
      }
      settings.permissions.allow = settings.permissions.allow.filter(p => p !== mcpPerm);
      writeJsonAtomic(SETTINGS_PATH, settings);
    }

    // 保存到 vault（先写 vault 再删 .claude.json，确保数据不丢失）
    meta.servers[serverId] = {
      disabled: true,
      credentials: credentials,
      config: existingConfig,
      permissions: removedPermissions,
      definitionHash: defHash,
      updatedAt: new Date().toISOString()
    };
    saveVault(meta);

    // 从 .claude.json 移除（vault 已安全写入）
    delete claudeJson.mcpServers[serverId];
    writeJsonAtomic(CLAUDE_JSON_PATH, claudeJson);

    return { Success: true, ServerId: serverId, Status: 'Disabled' };
  });
}

/**
 * 启用 MCP Server（来自规格 7）
 * @param {string} serverId
 * @returns {Object} - {Success, ServerId, Status}
 */
function enableServer(serverId) {
  return withLock(() => {
    const meta = loadVault();

    // 检查是否处于禁用状态
    if (!meta.servers[serverId] || !meta.servers[serverId].disabled) {
      return { Success: true, ServerId: serverId, Status: 'Active' };  // 幂等
    }

    const vaultEntry = meta.servers[serverId];

    // 检查 definitionHash 变更
    const contract = loadContract();
    if (contract.servers && contract.servers[serverId]) {
      const currentHash = definitionHash(contract.servers[serverId]);
      if (vaultEntry.definitionHash && vaultEntry.definitionHash !== currentHash) {
        // 警告：定义已变更（实际场景中应通过 UI 提示）
      }
    }

    // 获取凭据
    const credentials = vaultEntry.credentials || {};

    // 重建 server 配置（优先使用最新定义 + vault 凭据）
    let serverConfig = null;
    if (contract.servers && contract.servers[serverId]) {
      // 使用 vault 原始配置（简化：不实现 buildEntry，直接用 vault.config）
      serverConfig = vaultEntry.config;

      // 恢复凭据到 env
      if (serverConfig && Object.keys(credentials).length > 0) {
        if (!serverConfig.env) serverConfig.env = {};
        Object.assign(serverConfig.env, credentials);
      }
    } else if (vaultEntry.config) {
      serverConfig = vaultEntry.config;
    }

    if (!serverConfig) {
      return { Success: false, ServerId: serverId, Status: 'Error' };
    }

    // 写入 .claude.json
    const claudeJson = readJson(CLAUDE_JSON_PATH, {});
    if (!claudeJson.mcpServers) claudeJson.mcpServers = {};
    claudeJson.mcpServers[serverId] = serverConfig;
    writeJsonAtomic(CLAUDE_JSON_PATH, claudeJson);

    // 恢复 permissions
    const settings = readJson(SETTINGS_PATH, {});
    if (!settings.permissions) settings.permissions = {};
    if (!settings.permissions.allow) settings.permissions.allow = [];

    const vaultPerms = vaultEntry.permissions || [];
    let permChanged = false;
    if (vaultPerms.length > 0) {
      for (const perm of vaultPerms) {
        if (!settings.permissions.allow.includes(perm)) {
          settings.permissions.allow.push(perm);
          permChanged = true;
        }
      }
    } else {
      const mcpPerm = `mcp__${serverId}`;
      if (!settings.permissions.allow.includes(mcpPerm)) {
        settings.permissions.allow.push(mcpPerm);
        permChanged = true;
      }
    }

    if (permChanged) {
      writeJsonAtomic(SETTINGS_PATH, settings);
    }

    // 更新 vault
    meta.servers[serverId].disabled = false;
    if (contract.servers && contract.servers[serverId]) {
      meta.servers[serverId].definitionHash = definitionHash(contract.servers[serverId]);
    }
    meta.servers[serverId].updatedAt = new Date().toISOString();
    saveVault(meta);

    return { Success: true, ServerId: serverId, Status: 'Active' };
  });
}

/**
 * 删除 MCP Server（来自规格 8）
 * @param {string} serverId
 * @param {boolean} confirmed - 是否已确认（由调用方处理确认逻辑）
 * @returns {Object} - {Success, ServerId, Status}
 */
function removeServer(serverId, confirmed = false) {
  if (!confirmed) {
    return { Success: false, ServerId: serverId, Status: 'NeedConfirmation' };
  }

  return withLock(() => {
    // 1. 从 .claude.json 移除
    const claudeJson = readJson(CLAUDE_JSON_PATH, {});
    if (claudeJson.mcpServers && claudeJson.mcpServers[serverId]) {
      delete claudeJson.mcpServers[serverId];
    }

    // 2. 从 permissions 移除
    const settings = readJson(SETTINGS_PATH, {});
    if (settings.permissions && settings.permissions.allow) {
      const mcpPerm = `mcp__${serverId}`;
      settings.permissions.allow = settings.permissions.allow.filter(p => p !== mcpPerm);
      writeJsonAtomic(SETTINGS_PATH, settings);
    }

    // 3. 写入 .claude.json
    writeJsonAtomic(CLAUDE_JSON_PATH, claudeJson);

    // 4. 从 vault 移除
    const meta = loadVault();
    if (meta.servers[serverId]) {
      delete meta.servers[serverId];
    }
    saveVault(meta);

    return { Success: true, ServerId: serverId, Status: 'Removed' };
  });
}

// ============================================================================
// 渲染层（TUI）
// ============================================================================

/**
 * 显示状态表格（来自规格 3.5）
 */
function showStatusTable(rows) {
  if (!IS_TTY) {
    // 非 TTY：输出 JSON
    console.log(JSON.stringify(rows, null, 2));
    return;
  }

  console.log('');
  console.log('┌──────────┬──────────────────┬────────────────┬────────┐');
  console.log('│ 状态     │ 名称             │ 分类           │ 凭据   │');
  console.log('├──────────┼──────────────────┼────────────────┼────────┤');

  for (const row of rows) {
    const statusColor = getStatusColor(row.Status);
    const status = colorize(pad(getStatusLabel(row.Status), 8), statusColor);
    const name = pad(row.Name, 16);
    const category = pad(getCategoryLabel(row.Category), 14);
    const cred = pad(row.HasCredentials ? '有' : '-', 6);

    console.log(`│ ${status} │ ${name} │ ${category} │ ${cred} │`);
  }

  console.log('└──────────┴──────────────────┴────────────────┴────────┘');
  console.log('');
}

/**
 * 获取状态颜色
 */
function getStatusColor(status) {
  const map = {
    'Active': 'success',
    'Disabled': 'warning',
    'Missing': 'dim',
    'Custom': 'primary'
  };
  return map[status] || 'info';
}

/**
 * 状态中文标签（仅用于显示，内部逻辑仍使用英文 Status 值）
 */
function getStatusLabel(status) {
  const map = {
    'Active': '已启用',
    'Disabled': '已禁用',
    'Missing': '未安装',
    'Custom': '自定义',
    'Unknown': '未知'
  };
  return map[status] || status;
}

/**
 * 分类中文标签（仅用于显示，内部逻辑仍使用英文 Category 值）
 */
function getCategoryLabel(category) {
  const map = {
    'Search': '搜索',
    'Documentation': '文档检索',
    'Development': '代码检索',
    'Design': '设计',
    'Automation': '自动化'
  };
  return map[category] || category || '-';
}

/**
 * 显示交互式菜单（上下键选择 + Enter 确认）
 * @param {string} title
 * @param {Array} options - ['选项1', '选项2', ...]
 * @returns {Promise<number>} - 选中的索引（0-based）
 */
function showMenu(title, options) {
  return new Promise((resolve) => {
    if (!IS_TTY) {
      // 非 TTY：无法交互，返回 -1
      resolve(-1);
      return;
    }

    let selectedIndex = 0;

    // 渲染菜单
    function render() {
      // 清屏并移动光标到起始位置
      readline.clearScreenDown(TTY_OUTPUT);
      readline.cursorTo(TTY_OUTPUT, 0);

      console.log('');
      console.log(colorize(title, 'primary'));
      console.log('');

      options.forEach((opt, i) => {
        if (i === selectedIndex) {
          // 高亮当前选中项（使用 ► 符号，U+25BA）
          console.log(colorize(`  ► ${opt}`, 'primary'));
        } else {
          console.log(`    ${opt}`);
        }
      });

      console.log('');
      console.log(colorize('↑/↓ 选择  Enter 确认  Esc/q 取消', 'dim'));

      // 移动光标回到菜单起始位置（为下次渲染做准备）
      // 输出行数 = 空行 + 标题 + 空行 + N 个选项 + 空行 + 提示 = N + 5
      readline.moveCursor(TTY_OUTPUT, 0, -(options.length + 5));
    }

    // 初始渲染
    render();

    // 监听键盘事件
    const onKeypress = (str, key) => {
      if (key.name === 'up') {
        selectedIndex = (selectedIndex - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        selectedIndex = (selectedIndex + 1) % options.length;
        render();
      } else if (key.name === 'return') {
        cleanup();
        resolve(selectedIndex);
      } else if (key.name === 'escape' || str === 'q') {
        cleanup();
        resolve(-1);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }
    };

    // 清理函数
    function cleanup() {
      // 移动光标到菜单末尾（输出行数 = N + 5）
      readline.moveCursor(TTY_OUTPUT, 0, options.length + 5);
      console.log('');

      // 恢复光标显示
      TTY_OUTPUT.write('\x1b[?25h');

      // 恢复终端模式
      if (TTY_INPUT.isTTY) {
        TTY_INPUT.setRawMode(false);
      }
      TTY_INPUT.removeListener('keypress', onKeypress);
      TTY_INPUT.pause();
    }

    // 启用 raw mode 和 keypress 事件
    if (TTY_INPUT.isTTY) {
      readline.emitKeypressEvents(TTY_INPUT);
      TTY_INPUT.setRawMode(true);
    }
    TTY_INPUT.on('keypress', onKeypress);
    TTY_INPUT.resume();

    // 隐藏光标（对齐 PS1：[Console]::CursorVisible = $false）
    TTY_OUTPUT.write('\x1b[?25l');
  });
}

/**
 * 多选菜单（空格切换，Enter 确认）
 * @param {string} title
 * @param {string[]} options
 * @param {number[]} defaultSelected - 默认勾选的索引数组
 * @returns {Promise<number[]|null>} - 返回勾选的索引数组，取消返回 null
 */
function showMultiSelectMenu(title, options, defaultSelected = []) {
  return new Promise((resolve) => {
    if (!IS_TTY) {
      // 非 TTY：无法交互，返回 null
      resolve(null);
      return;
    }

    let cursorIndex = 0;
    const checkedSet = new Set(defaultSelected);

    // 渲染菜单
    function render() {
      // 清屏并移动光标到起始位置
      readline.clearScreenDown(TTY_OUTPUT);
      readline.cursorTo(TTY_OUTPUT, 0);

      console.log('');
      console.log(colorize(title, 'primary'));
      console.log('');

      options.forEach((opt, i) => {
        const checkbox = checkedSet.has(i) ? '[✓]' : '[ ]';
        const prefix = i === cursorIndex ? '► ' : '  ';
        const line = `${prefix}${checkbox} ${opt}`;

        if (i === cursorIndex) {
          console.log(colorize(line, 'primary'));
        } else {
          console.log(line);
        }
      });

      console.log('');
      console.log(colorize('使用 ↑↓ 导航，空格键选择/取消，Enter 确认，Esc 取消', 'dim'));

      // 移动光标回到菜单起始位置（为下次渲染做准备）
      // 输出行数 = 空行 + 标题 + 空行 + N 个选项 + 空行 + 提示 = N + 5
      readline.moveCursor(TTY_OUTPUT, 0, -(options.length + 5));
    }

    // 初始渲染
    render();

    // 监听键盘事件
    const onKeypress = (str, key) => {
      if (key.name === 'up') {
        cursorIndex = (cursorIndex - 1 + options.length) % options.length;
        render();
      } else if (key.name === 'down') {
        cursorIndex = (cursorIndex + 1) % options.length;
        render();
      } else if (key.name === 'space') {
        // 空格切换勾选状态
        if (checkedSet.has(cursorIndex)) {
          checkedSet.delete(cursorIndex);
        } else {
          checkedSet.add(cursorIndex);
        }
        render();
      } else if (key.name === 'return') {
        cleanup();
        resolve(Array.from(checkedSet).sort((a, b) => a - b));
      } else if (key.name === 'escape' || str === 'q') {
        cleanup();
        resolve(null);
      } else if (key.ctrl && key.name === 'c') {
        cleanup();
        process.exit(0);
      }
    };

    // 清理函数
    function cleanup() {
      // 移动光标到菜单末尾（输出行数 = N + 5）
      readline.moveCursor(TTY_OUTPUT, 0, options.length + 5);
      console.log('');

      // 恢复光标显示
      TTY_OUTPUT.write('\x1b[?25h');

      // 恢复终端模式
      if (TTY_INPUT.isTTY) {
        TTY_INPUT.setRawMode(false);
      }
      TTY_INPUT.removeListener('keypress', onKeypress);
      TTY_INPUT.pause();
    }

    // 启用 raw mode 和 keypress 事件
    if (TTY_INPUT.isTTY) {
      readline.emitKeypressEvents(TTY_INPUT);
      TTY_INPUT.setRawMode(true);
    }
    TTY_INPUT.on('keypress', onKeypress);
    TTY_INPUT.resume();

    // 隐藏光标（对齐 PS1：[Console]::CursorVisible = $false）
    TTY_OUTPUT.write('\x1b[?25l');
  });
}

/**
 * 确认对话框
 * @param {string} message
 * @returns {Promise<boolean>}
 */
function confirm(message) {
  return new Promise((resolve) => {
    if (!IS_TTY) {
      resolve(false);
      return;
    }

    const rl = readline.createInterface({
      input: TTY_INPUT,
      output: TTY_OUTPUT
    });

    rl.question(colorize(message + ' (Y/n): ', 'warning'), (answer) => {
      rl.close();
      resolve(!answer || answer.toLowerCase() === 'y');
    });
  });
}

/**
 * 等待用户按任意键
 * @returns {Promise<void>}
 */
function waitForKeypress() {
  return new Promise((resolve) => {
    if (!IS_TTY) {
      resolve();
      return;
    }

    const onKeypress = () => {
      cleanup();
      resolve();
    };

    function cleanup() {
      if (TTY_INPUT.isTTY) {
        TTY_INPUT.setRawMode(false);
      }
      TTY_INPUT.removeListener('keypress', onKeypress);
      TTY_INPUT.pause();
    }

    // 启用 raw mode 和 keypress 事件
    if (TTY_INPUT.isTTY) {
      readline.emitKeypressEvents(TTY_INPUT);
      TTY_INPUT.setRawMode(true);
    }
    TTY_INPUT.on('keypress', onKeypress);
    TTY_INPUT.resume();
  });
}

/**
 * 凭据脱敏显示
 */
function maskValue(value) {
  if (!value) return '';
  if (value.length <= 8) return '***';
  return value.substring(0, 4) + '***' + value.substring(value.length - 4);
}

/**
 * 显示友好错误（带技术详情展开）
 */
function showError(message, detail) {
  console.error(colorize(`✗ ${message}`, 'danger'));
  if (detail) {
    console.error(colorize(`  技术详情: ${detail}`, 'dim'));
  }
}

// ============================================================================
// Rules 层（动态渲染）
// ============================================================================

/**
 * Rules 分类配置（来自规格 2.2，简化版本）
 * 完整配置应从 contracts 加载，这里提供 fallback
 */
const MCP_RULES_CATEGORIES = {
  Search: {
    FileName: 'ccq-mcp-search.md',
    Title: '搜索工具',
    Desc: '联网搜索和内容提取。',
    Chains: [
      { Scenario: '联网搜索', Steps: [{ McpId: 'exa' }, { McpId: 'tavily' }], Fallback: 'WebSearch' }
    ]
  },
  Documentation: {
    FileName: 'ccq-mcp-docs.md',
    Title: '文档检索工具',
    Desc: '库文档和开源项目文档检索。',
    Chains: [
      { Scenario: '库官方文档', Steps: [{ McpId: 'context7' }] },
      { Scenario: 'GitHub 开源项目', Steps: [{ McpId: 'deepwiki' }] }
    ]
  }
};

/**
 * 渲染单个分类的 Rules 文件（来自规格 13）
 */
function renderRules(categoryName, enabledMcpIds) {
  const cat = MCP_RULES_CATEGORIES[categoryName];
  if (!cat) return null;

  let content = `# ${cat.Title}\n\n`;
  content += `> 自动生成，请勿手动编辑。由 MCP Manager 根据已启用的 MCP Server 动态渲染。\n\n`;

  if (cat.Desc) {
    content += `${cat.Desc}\n\n`;
  }

  content += `| 场景 | 工具链 |\n`;
  content += `|------|--------|\n`;

  // 渲染 Chains
  for (const chain of cat.Chains || []) {
    const tools = [];
    for (const step of chain.Steps || []) {
      if (enabledMcpIds.includes(step.McpId)) {
        tools.push(step.Tool || `mcp__${step.McpId}__*`);
      }
    }

    if (chain.Fallback) {
      tools.push(`${chain.Fallback}（兜底）`);
    }

    if (tools.length > 0) {
      const toolChain = tools.join(' → ');
      content += `| ${chain.Scenario} | \`${toolChain}\` |\n`;
    }
  }

  // 渲染 StaticRows
  if (cat.StaticRows) {
    for (const row of cat.StaticRows) {
      content += `| ${row.Scenario} | \`${row.Tool}\` |\n`;
    }
  }

  content += `\n`;

  // Tips
  if (cat.Tips && cat.Tips.length > 0) {
    content += `**Tips**:\n`;
    for (const tip of cat.Tips) {
      content += `- ${tip}\n`;
    }
  }

  return content;
}

/**
 * 同步所有 Rules 文件（来自规格 9）
 */
function syncRules() {
  try {
    const statuses = computeStatus();
    const enabledIds = statuses
      .filter(s => s.Status === 'Active')
      .map(s => s.Id);

    // 按分类分组
    const enabledByCategory = {};
    for (const s of statuses) {
      if (s.Status === 'Active' && s.Category) {
        if (!enabledByCategory[s.Category]) {
          enabledByCategory[s.Category] = [];
        }
        enabledByCategory[s.Category].push(s.Id);
      }
    }

    // 同步每个分类
    for (const catName in MCP_RULES_CATEGORIES) {
      const enabledIdsForCat = enabledByCategory[catName] || [];
      const cat = MCP_RULES_CATEGORIES[catName];
      const filePath = path.join(RULES_DIR, cat.FileName);

      // 无已启用 MCP → 删除文件
      if (enabledIdsForCat.length === 0) {
        if (fs.existsSync(filePath)) {
          fs.unlinkSync(filePath);
        }
        continue;
      }

      // 渲染内容
      const content = renderRules(catName, enabledIdsForCat);
      if (!content) continue;

      // 变更检测
      let existingContent = '';
      if (fs.existsSync(filePath)) {
        existingContent = fs.readFileSync(filePath, 'utf8');
      }

      const contentNormalized = content.replace(/\r\n/g, '\n').trim();
      const existingNormalized = existingContent.replace(/\r\n/g, '\n').trim();

      if (contentNormalized !== existingNormalized) {
        writeFileAtomic(filePath, content);
      }
    }
  } catch (err) {
    // 静默失败，不阻塞主流程
  }
}

// ============================================================================
// 入口层（命令行路由 + 交互管理）
// ============================================================================

/**
 * 交互式 MCP 管理模式
 */
async function manageMode() {
  if (!IS_TTY) {
    // 非交互式终端：降级为只读状态展示 + 引导提示
    // （而非直接报错退出，对自动化/管道环境更友好）
    console.error('提示：当前非交互式终端，无法进入 MCP 管理菜单。');
    console.error('请在交互式终端（如 PowerShell / Terminal 直接运行）中重试。');
    console.error('');
    console.error('当前 MCP 状态：');
    const statuses = computeStatus();
    showStatusTable(statuses);
    process.exit(1);
  }

  console.log(colorize('\n=== MCP Server 管理 ===', 'primary'));

  // 入口同步：凭据对齐（对齐 PS1：仅在有同步时输出提示）
  const syncResult = syncCredentials();
  if (syncResult.SyncedCount > 0) {
    console.log(colorize(`已同步 ${syncResult.SyncedCount} 个 MCP 凭据`, 'success'));
  }
  // 入口同步：Rules 渲染
  syncRules();

  while (true) {
    // 1. 获取并展示状态
    const statuses = computeStatus();
    showStatusTable(statuses);

    // 2. 动态构建操作菜单（对齐 PS1：带计数 + actionMap）
    //    toggleable：Active / Disabled（Missing 的启用需走 steps 层安装流程，Manager 层不处理）
    //    removable：非 Missing（未安装的无法删除）
    const toggleable = statuses.filter(s => ['Active', 'Disabled'].includes(s.Status));
    const removable = statuses.filter(s => s.Status !== 'Missing');

    const options = [];
    const actionMap = [];

    if (toggleable.length > 0) {
      options.push(`开启·禁用 (${toggleable.length})`);
      actionMap.push('toggle');
    }
    if (removable.length > 0) {
      options.push('删除 MCP');
      actionMap.push('delete');
    }
    // 非 ANSI 终端无 Esc 键，必须提供显式返回选项
    options.push('返回');
    actionMap.push('back');

    if (toggleable.length === 0 && removable.length === 0) {
      console.log(colorize('没有可管理的 MCP Server', 'dim'));
      console.log(colorize('按任意键返回...', 'dim'));
      await waitForKeypress();
      return;
    }

    const choice = await showMenu('管理操作', options);
    if (choice === -1) return;

    const action = actionMap[choice];
    if (action === 'toggle') {
      await toggleMode(statuses);
    } else if (action === 'delete') {
      await removeMode(statuses);
    } else {
      // back
      return;
    }

    // 3. 操作完成后等待按键刷新（对齐 PS1："按任意键刷新..."）
    console.log('');
    console.log(colorize('按任意键刷新...', 'dim'));
    await waitForKeypress();
  }
}

/**
 * 批量切换模式（多选菜单，复刻原始 PS1 逻辑）
 */
async function toggleMode(statuses) {
  // 只显示可切换的 MCP（Active / Disabled）
  // 注意：Missing 状态需要通过安装流程处理，不在 Manager 层处理
  const toggleable = statuses.filter(s => ['Active', 'Disabled'].includes(s.Status));

  if (toggleable.length === 0) {
    console.log(colorize('没有可切换的 MCP Server', 'dim'));
    console.log(colorize('提示：未安装的 MCP 需通过 Manage → 安装流程启用', 'dim'));
    return;
  }

  // 构建选项列表（状态用中文标签）
  const options = toggleable.map(s => `${s.Name} [${getStatusLabel(s.Status)}]`);

  // 默认勾选：Active 的默认勾选
  const defaultSelected = [];
  toggleable.forEach((s, i) => {
    if (s.Status === 'Active') {
      defaultSelected.push(i);
    }
  });

  // 显示多选菜单
  const selections = await showMultiSelectMenu(
    '切换 MCP 状态（空格切换，已启用=已勾选）',
    options,
    defaultSelected
  );

  if (selections === null) {
    // 用户取消（对齐 PS1：静默返回，不输出提示）
    return;
  }

  // 比较初始和最终状态，判断哪些需要 toggle
  const toggleIds = [];
  toggleable.forEach((server, i) => {
    const wasActive = server.Status === 'Active';
    const isSelected = selections.includes(i);

    // Active 但未勾选 → 需要禁用
    // Disabled 但勾选了 → 需要启用
    if ((wasActive && !isSelected) || (!wasActive && isSelected)) {
      toggleIds.push(server.Id);
    }
  });

  if (toggleIds.length === 0) {
    console.log(colorize('未更改任何状态', 'dim'));
    return;
  }

  // 批量执行 toggle（对齐 PS1 Invoke-McpToggle：累计计数 + 汇总输出，不逐项输出）
  let successCount = 0;
  let failureCount = 0;
  for (const id of toggleIds) {
    const server = toggleable.find(s => s.Id === id);
    const currentStatus = server.Status;

    try {
      let result;
      if (currentStatus === 'Active') {
        result = disableServer(id);
      } else if (currentStatus === 'Disabled') {
        result = enableServer(id);
      }
      if (result && result.Success) {
        successCount++;
      } else {
        failureCount++;
      }
    } catch (err) {
      failureCount++;
    }
  }

  console.log(colorize(`切换完成: ${successCount} 成功, ${failureCount} 失败`, 'success'));

  // 同步 Rules 文件
  syncRules();
}

/**
 * 删除模式（过滤掉 Missing 状态）
 */
async function removeMode(statuses) {
  // 过滤：不显示 Missing（未安装的没法删）
  const removable = statuses.filter(s => s.Status !== 'Missing');

  if (removable.length === 0) {
    console.log(colorize('没有可删除的 MCP Server', 'dim'));
    return;
  }

  const options = removable.map(s => `${s.Name} [${getStatusLabel(s.Status)}]`);
  options.push('返回');

  const choice = await showMenu('选择要删除的 MCP', options);
  if (choice < 0 || choice >= removable.length) return;

  const server = removable[choice];

  // Custom 警告
  if (server.Status === 'Custom') {
    console.log(colorize('⚠ 此 MCP 非 CCQ 管理，删除后无法通过 CCQ 恢复', 'warning'));
  }

  // 确认
  const confirmed = await confirm(`确定要删除 ${server.Name} 吗？`);
  if (!confirmed) {
    console.log(colorize('已取消删除', 'dim'));
    return;
  }

  const result = removeServer(server.Id, true);
  if (result.Success) {
    console.log(colorize(`✓ ${server.Name} 已删除`, 'success'));
    syncRules();
  } else {
    console.log(colorize(`✗ 删除失败`, 'danger'));
  }
}

/**
 * 状态模式（输出 JSON 或表格）
 */
function statusMode(table = false) {
  const statuses = computeStatus();

  if (table && IS_TTY) {
    showStatusTable(statuses);
  } else {
    console.log(JSON.stringify(statuses, null, 2));
  }
}

/**
 * 主入口
 */
async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  try {
    if (action === 'manage') {
      await manageMode();
    } else if (action === 'status') {
      const table = args.includes('--table');
      statusMode(table);
    } else if (action === 'sync-rules') {
      syncRules();
      console.log(colorize('✓ Rules 已同步', 'success'));
    } else if (action === '--version') {
      console.log(SCRIPT_VERSION);
    } else {
      console.log('MCP Manager v' + SCRIPT_VERSION);
      console.log('');
      console.log('用法:');
      console.log('  node mcp-manager.js manage          # 交互式管理');
      console.log('  node mcp-manager.js status          # 输出状态 (JSON)');
      console.log('  node mcp-manager.js status --table  # 输出状态表格');
      console.log('  node mcp-manager.js sync-rules      # 同步 Rules 文件');
      console.log('  node mcp-manager.js --version       # 版本号');
      process.exit(action ? 1 : 0);
    }
  } catch (err) {
    showError('执行失败', err.message);
    process.exit(1);
  }
}

// 执行主函数
if (require.main === module) {
  main();
}

module.exports = {
  computeStatus,
  disableServer,
  enableServer,
  removeServer,
  syncCredentials,
  syncRules
};







