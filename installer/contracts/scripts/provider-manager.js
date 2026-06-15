#!/usr/bin/env node
/**
 * Provider Manager - 供应商管理核心
 *
 * 职责：Provider CRUD + 供应商切换 + settings.json 字段所有权同步
 * 对照基准：installer/windows/core/Provider.ps1（2248 行，HC-FEATURE-PARITY）
 *
 * 架构（对齐 mcp-manager.js）：
 * - [常量层] SCRIPT_VERSION、路径、颜色、受管 env 键
 * - [工具层] readJson、atomicWrite（复用 manage.js）、escapeRegex、normalizeBaseUrl、maskApiKey、key 工具
 * - [契约层] loadProviderContract + 内联 fallback + 一致性断言（对齐 Initialize-ProviderRuntimeConfig）
 * - [受管 env 层] 模型 env / 额外 env 读写、旧版 modelMapping 兼容、effective 合并、摘要
 * - [数据层] getProviderList、getActiveProvider、BaseUrl+Token 身份匹配、getDisplayData
 * - [变更层] syncFromSettings、addProvider、editProvider、deleteProvider、switchProvider
 * - [Profile 工具] updateProfileMarker（design D5，供 Phase 3 Update 复用）
 * - [入口层] main（--version / status，TUI Dashboard 待 Phase 1b）
 *
 * 字段所有权（HC-SETTINGS-OWNERSHIP）：
 * - Provider 只改 env.ANTHROPIC_AUTH_TOKEN / ANTHROPIC_BASE_URL + 受管模型键 + 受管额外键
 * - 绝不触碰 model / language / permissions / hooks / statusLine / mcpServers
 *
 * 锁语义（design D6）：
 * - manage.js 的 withProfileLock 非重入，故所有变更走 *Unlocked 内部函数 + 公开函数包锁
 * - addProvider 激活时在锁内直接调用 switchProviderUnlocked，避免重入死锁
 *
 * @author 哈雷酱（傲娇大小姐工程师）
 * @version 1.0.0
 */

'use strict';

const fs = require('fs');
const path = require('path');
const os = require('os');
const crypto = require('crypto');
const readline = require('readline');
const tty = require('tty');

// 复用 manage.js 共享工具（构建打包后内联）
let shared;
try {
  shared = require('./manage.js');
} catch (e) {
  shared = null;
}

const atomicWrite = shared?.atomicWrite || function (filePath, content) {
  const dir = path.dirname(filePath);
  if (!fs.existsSync(dir)) fs.mkdirSync(dir, { recursive: true });
  fs.writeFileSync(filePath, content, 'utf8');
};
const withProfileLock = shared?.withProfileLock || ((fn) => fn());
const displayWidth = shared?.displayWidth || ((s) => (s ? Array.from(s).length : 0));
const pad = shared?.pad || ((s, w) => s + ' '.repeat(Math.max(0, w - displayWidth(s))));

// ============================================================================
// 常量层
// ============================================================================

const SCRIPT_VERSION = '1.0.0';

const HOME = process.env.HOME || process.env.USERPROFILE;
const SETTINGS_PATH = path.join(HOME, '.claude', 'settings.json');
const PROVIDERS_DIR = path.join(HOME, '.claude', 'providers');

const COLORS = {
  primary: '\x1b[38;2;217;119;87m', // Claude Orange
  success: '\x1b[92m',
  warning: '\x1b[93m',
  danger: '\x1b[91m',
  info: '\x1b[97m',
  dim: '\x1b[90m',
  reset: '\x1b[0m',
};

// Profile 标记块（对齐 Profile.ps1 HC-4 + design D5）
const MARKER_START = '# >>> Claude Code Quickstart >>>';
const MARKER_END = '# <<< Claude Code Quickstart <<<';

// TTY 检测与流准备（复用 mcp-manager.js 的 TTY 处理，供 Phase 1b TUI 使用）
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
  TTY_OWNS_FD = false;
}

const SUPPORTS_ANSI = IS_TTY;

function cleanupGlobalTTY() {
  if (TTY_OWNS_FD && TTY_INPUT && TTY_OUTPUT) {
    try {
      if (TTY_INPUT.isTTY && typeof TTY_INPUT.setRawMode === 'function') {
        TTY_INPUT.setRawMode(false);
      }
      TTY_INPUT.destroy();
      TTY_OUTPUT.destroy();
    } catch (e) { /* 静默 */ }
  }
}

function colorize(text, colorKey) {
  if (!SUPPORTS_ANSI) return text;
  return COLORS[colorKey] + text + COLORS.reset;
}

// ============================================================================
// 工具层
// ============================================================================

/** 安全读取 JSON，失败返回 fallback（对齐 mcp-manager.js readJson） */
function readJson(filePath, fallback) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const raw = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(raw);
  } catch (e) {
    return fallback;
  }
}

/** 原子写入 JSON（2 空格缩进） */
function writeJsonAtomic(filePath, obj) {
  return atomicWrite(filePath, JSON.stringify(obj, null, 2));
}

function escapeRegex(str) {
  return String(str).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

function isNullOrWhiteSpace(s) {
  return s == null || String(s).trim() === '';
}

/** 脱敏 API Key（前 4 位 + ... + 后 2 位，对齐 Get-MaskedApiKey） */
function maskApiKey(key) {
  if (isNullOrWhiteSpace(key)) return '-';
  const s = String(key);
  if (s.length <= 8) return '***';
  return s.substring(0, 4) + '...' + s.substring(s.length - 2);
}

/** 规范化 Base URL（去尾斜杠，对齐 Normalize-ProviderBaseUrl） */
function normalizeBaseUrl(baseUrl) {
  if (isNullOrWhiteSpace(baseUrl)) return '';
  return String(baseUrl).trim().replace(/\/+$/, '');
}

/** 判断 settings BaseUrl 是否匹配 Profile BaseUrl（对齐 Test-ProviderBaseUrlMatch） */
function testProviderBaseUrlMatch(settingsBaseUrl, profileBaseUrl) {
  const a = normalizeBaseUrl(settingsBaseUrl);
  const b = normalizeBaseUrl(profileBaseUrl);
  if (!a || !b) return false;
  return a === b || a.toLowerCase().startsWith(b.toLowerCase() + '/');
}

/** 判断 settings 与 Profile 是否同一 Token（大小写敏感，对齐 Test-ProviderAuthTokenMatch） */
function testProviderAuthTokenMatch(settingsToken, profileToken) {
  return !isNullOrWhiteSpace(settingsToken)
    && !isNullOrWhiteSpace(profileToken)
    && String(settingsToken) === String(profileToken);
}

/** 校验 Provider Key 合法性（防路径穿越，对齐 Test-ProviderKey） */
function testProviderKey(key) {
  return !isNullOrWhiteSpace(key) && /^[A-Za-z0-9._-]+$/.test(String(key));
}

/** SHA-256 指纹（对齐 Get-StringFingerprint） */
function stringFingerprint(text) {
  return crypto.createHash('sha256').update(String(text), 'utf8').digest('hex');
}

/**
 * 生成自定义供应商 Key：优先名称，回退 URL（host + 可选路径哈希）
 * 对齐 New-CustomProviderKey
 */
function newCustomProviderKey(name, baseUrl) {
  if (!isNullOrWhiteSpace(name)) {
    const sanitized = String(name).trim().toLowerCase()
      .replace(/[^a-z0-9-]/g, '-')
      .replace(/-{2,}/g, '-')
      .replace(/^-|-$/g, '');
    if (sanitized) return 'custom-' + sanitized;
  }
  try {
    const uri = new URL(String(baseUrl).trim().replace(/\/+$/, ''));
    const hostPart = uri.hostname.toLowerCase().replace(/\./g, '-');
    if (uri.pathname && uri.pathname !== '/') {
      const pathHash = stringFingerprint(uri.pathname).substring(0, 4);
      return `custom-${hostPart}-${pathHash}`;
    }
    return `custom-${hostPart}`;
  } catch (e) {
    return 'custom-manual';
  }
}

/**
 * 计算下一个可用递增 key（如 zhipu → zhipu-2 → zhipu-3）
 * 对齐 Get-NextAvailableKey
 */
function getNextAvailableKey(baseKey, profilesDir) {
  if (!fs.existsSync(profilesDir)) return `${baseKey}-2`;
  let files = [];
  try {
    files = fs.readdirSync(profilesDir).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return `${baseKey}-2`;
  }
  if (files.length === 0) return `${baseKey}-2`;
  const pattern = new RegExp('^' + escapeRegex(baseKey) + '(?:-(\\d+))?$');
  let maxNum = 1; // 基础 key 视为序号 1
  for (const f of files) {
    const k = path.basename(f, '.json');
    const m = k.match(pattern);
    if (!m) continue;
    if (m[1]) {
      const n = parseInt(m[1], 10);
      if (!isNaN(n) && n > maxNum) maxNum = n;
    }
  }
  return `${baseKey}-${maxNum + 1}`;
}

/** 查找属于指定内置供应商的所有 Profile 实例（对齐 Find-BuiltinProviderProfiles） */
function findBuiltinProviderProfiles(builtinKey, profiles) {
  if (!profiles || profiles.length === 0) return [];
  const pattern = new RegExp('^' + escapeRegex(builtinKey) + '-\\d+$');
  return profiles.filter((p) => p.key === builtinKey || pattern.test(p.key));
}

/** 从 Profile key 解析内置供应商基础 key（兼容 key-N 副本，对齐 Get-BuiltinProviderKeyFromProfileKey） */
function getBuiltinProviderKeyFromProfileKey(key) {
  if (isNullOrWhiteSpace(key)) return '';
  for (const builtinKey of Object.keys(RUNTIME_CONFIG.builtinProviders)) {
    if (builtinKey === 'custom') continue;
    const pattern = new RegExp('^' + escapeRegex(builtinKey) + '(?:-\\d+)?$');
    if (pattern.test(key)) return builtinKey;
  }
  return '';
}

// ============================================================================
// 契约层（contracts-first + 内联 fallback + 一致性断言）
// ============================================================================

/**
 * 内联 fallback 配置（release artifact / contracts 不可用时使用）
 * 必须与 installer/contracts/providers.json 保持一致（由 assertFallbackConsistency 强制）
 * 对齐 Get-InlineProviderRuntimeConfig
 */
const INLINE_PROVIDER_CONFIG = {
  managedModelEnvKeys: [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
  ],
  modelEnvLabels: {
    ANTHROPIC_DEFAULT_HAIKU_MODEL: 'Haiku 模型',
    ANTHROPIC_DEFAULT_OPUS_MODEL: 'Opus 模型',
    ANTHROPIC_DEFAULT_SONNET_MODEL: 'Sonnet 模型',
  },
  managedExtraEnvKeys: [
    'ANTHROPIC_MODEL',
    'CLAUDE_CODE_SUBAGENT_MODEL',
    'CLAUDE_CODE_EFFORT_LEVEL',
    'CLAUDE_CODE_DISABLE_NONSTREAMING_FALLBACK',
    'API_TIMEOUT_MS',
    'ENABLE_TOOL_SEARCH',
  ],
  legacyModelKey: 'modelMapping',
  builtinProviders: {
    zhipu: {
      name: '智谱 GLM',
      description: '智谱 GLM Coding Plan，默认使用 GLM-5.1 系列模型',
      baseUrl: 'https://open.bigmodel.cn/api/anthropic',
      platformUrl: 'https://bigmodel.cn/usercenter/proj-mgmt/apikeys',
      modelEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'glm-4.5-air',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'glm-5.1',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'glm-5.1',
      },
      extraEnv: { API_TIMEOUT_MS: '3000000' },
    },
    minimax: {
      name: 'MiniMax',
      description: 'MiniMax API，默认使用 MiniMax-M3',
      baseUrl: 'https://api.minimaxi.com/anthropic',
      platformUrl: 'https://platform.minimaxi.com/user-center/basic-information/interface-key',
      modelEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'MiniMax-M3',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'MiniMax-M3',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'MiniMax-M3',
      },
      extraEnv: { ANTHROPIC_MODEL: 'MiniMax-M3', API_TIMEOUT_MS: '3000000' },
    },
    moonshot: {
      name: 'Kimi Code',
      description: 'Kimi Code 会员专属 API，使用 sk-kimi- 前缀 Key',
      baseUrl: 'https://api.kimi.com/coding/',
      platformUrl: 'https://www.kimi.com/code/console',
      modelEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'kimi-for-coding',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'kimi-for-coding',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'kimi-for-coding',
      },
      extraEnv: {
        ANTHROPIC_MODEL: 'kimi-for-coding',
        CLAUDE_CODE_SUBAGENT_MODEL: 'kimi-for-coding',
        ENABLE_TOOL_SEARCH: 'false',
      },
    },
    deepseek: {
      name: 'DeepSeek',
      description: 'DeepSeek Anthropic API，支持 V4 Pro/Flash 与 1M 上下文',
      baseUrl: 'https://api.deepseek.com/anthropic',
      platformUrl: 'https://platform.deepseek.com/api_keys',
      modelEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'deepseek-v4-flash',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'deepseek-v4-pro[1m]',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'deepseek-v4-pro[1m]',
      },
      extraEnv: {
        ANTHROPIC_MODEL: 'deepseek-v4-pro[1m]',
        CLAUDE_CODE_SUBAGENT_MODEL: 'deepseek-v4-flash',
        CLAUDE_CODE_EFFORT_LEVEL: 'max',
      },
    },
    bailian: {
      name: '阿里云百炼',
      description: '阿里云百炼平台，默认使用 Qwen3.7 Plus',
      baseUrl: 'https://coding.dashscope.aliyuncs.com/apps/anthropic',
      platformUrl: 'https://bailian.console.aliyun.com/cn-beijing/?tab=coding-plan#/efm/coding-plan-detail',
      modelEnv: {
        ANTHROPIC_DEFAULT_HAIKU_MODEL: 'qwen3.7-plus',
        ANTHROPIC_DEFAULT_OPUS_MODEL: 'qwen3.7-plus',
        ANTHROPIC_DEFAULT_SONNET_MODEL: 'qwen3.7-plus',
      },
      extraEnv: {
        ANTHROPIC_MODEL: 'qwen3.7-plus',
        CLAUDE_CODE_SUBAGENT_MODEL: 'qwen3.7-plus',
      },
    },
    custom: {
      name: '自定义供应商',
      description: '手动配置 Base URL 和 API Key',
      baseUrl: '',
      platformUrl: '',
    },
  },
};

/**
 * 将 providers.json 契约（PascalCase）规范化为运行时配置（camelCase）
 * 对齐 ConvertTo-ProviderRuntimeConfig + ConvertTo-BuiltinProvidersFromContract
 */
function normalizeContract(raw) {
  const managedEnv = (raw && raw.ManagedEnv) || {};
  const result = {
    managedModelEnvKeys: (managedEnv.ProviderManagedModelEnvKeys || []).map((v) => String(v)),
    modelEnvLabels: {},
    managedExtraEnvKeys: (managedEnv.ProviderManagedExtraEnvKeys || []).map((v) => String(v)),
    legacyModelKey: String(managedEnv.LegacyProviderModelKey || 'modelMapping'),
    builtinProviders: {},
  };
  const labels = managedEnv.ProviderModelEnvLabels || {};
  for (const [k, v] of Object.entries(labels)) {
    result.modelEnvLabels[String(k)] = String(v);
  }
  const builtins = (raw && raw.BuiltinProviders) || {};
  for (const [key, p] of Object.entries(builtins)) {
    const item = {
      name: String((p && p.Name) || ''),
      description: String((p && p.Description) || ''),
      baseUrl: String((p && p.BaseUrl) || ''),
      platformUrl: String((p && p.PlatformUrl) || ''),
    };
    if (p && p.ModelEnv && typeof p.ModelEnv === 'object') {
      item.modelEnv = {};
      for (const [mk, mv] of Object.entries(p.ModelEnv)) item.modelEnv[String(mk)] = String(mv);
    }
    if (p && p.ExtraEnv && typeof p.ExtraEnv === 'object') {
      item.extraEnv = {};
      for (const [ek, ev] of Object.entries(p.ExtraEnv)) item.extraEnv[String(ek)] = String(ev);
    }
    if (p && p.RequireModelConfig !== undefined) {
      item.requireModelConfig = Boolean(p.RequireModelConfig);
    }
    result.builtinProviders[key] = item;
  }
  return result;
}

/**
 * 生成用于一致性比较的稳定 JSON（键排序）
 * 对齐 ConvertTo-ProviderComparableJson
 */
function comparableConfigJson(config) {
  const labels = {};
  Object.keys(config.modelEnvLabels).sort().forEach((k) => { labels[k] = config.modelEnvLabels[k]; });
  const providers = {};
  Object.keys(config.builtinProviders).sort().forEach((key) => {
    const p = config.builtinProviders[key];
    const modelEnv = {};
    if (p.modelEnv) Object.keys(p.modelEnv).sort().forEach((k) => { modelEnv[k] = p.modelEnv[k]; });
    const extraEnv = {};
    if (p.extraEnv) Object.keys(p.extraEnv).sort().forEach((k) => { extraEnv[k] = p.extraEnv[k]; });
    providers[key] = {
      name: p.name,
      description: p.description,
      baseUrl: p.baseUrl,
      platformUrl: p.platformUrl,
      requireModelConfig: Boolean(p.requireModelConfig),
      modelEnv,
      extraEnv,
    };
  });
  return JSON.stringify({
    managedModelEnvKeys: config.managedModelEnvKeys.map(String),
    modelEnvLabels: labels,
    managedExtraEnvKeys: config.managedExtraEnvKeys.map(String),
    legacyModelKey: config.legacyModelKey,
    builtinProviders: providers,
  });
}

/**
 * 强制 providers.json 与内联 fallback 一致（对齐 Assert-ProviderFallbackConsistency）
 * 不一致直接抛错，防止契约与 fallback 漂移
 */
function assertFallbackConsistency(contractConfig) {
  const a = comparableConfigJson(contractConfig);
  const b = comparableConfigJson(INLINE_PROVIDER_CONFIG);
  if (a !== b) {
    throw new Error('installer/contracts/providers.json 与 provider-manager.js 内联 fallback 不一致，请同步更新二者。');
  }
}

let RUNTIME_CONFIG = null;

/**
 * 加载 Provider 契约：优先源码 contracts/providers.json，fallback 内联
 * 对齐 Get-ProviderContract + Initialize-ProviderRuntimeConfig（带缓存）
 */
function loadProviderContract() {
  if (RUNTIME_CONFIG) return RUNTIME_CONFIG;
  const possiblePaths = [
    path.join(__dirname, '..', 'providers.json'), // 源码模式：contracts/scripts/../providers.json
    path.join(__dirname, 'providers.json'),       // 同目录（部署场景）
  ];
  for (const p of possiblePaths) {
    if (fs.existsSync(p)) {
      const raw = readJson(p, null);
      if (raw) {
        const config = normalizeContract(raw);
        assertFallbackConsistency(config);
        RUNTIME_CONFIG = config;
        return RUNTIME_CONFIG;
      }
    }
  }
  RUNTIME_CONFIG = INLINE_PROVIDER_CONFIG;
  return RUNTIME_CONFIG;
}

// 模块加载时初始化运行时配置（对齐 PS 末尾的 Initialize-ProviderRuntimeConfig 调用）
loadProviderContract();

// ============================================================================
// 受管 env 层（模型 env / 额外 env / 旧版兼容 / effective 合并 / 摘要）
// ============================================================================

/** 旧版别名映射（opus/sonnet/haiku）→ 受管模型 env 键（对齐 Get-ProviderManagedModelEnvFromLegacyAliases） */
function getManagedModelEnvFromLegacyAliases(legacyAliases) {
  const result = {};
  if (!legacyAliases) return result;
  const map = {
    haiku: 'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    opus: 'ANTHROPIC_DEFAULT_OPUS_MODEL',
    sonnet: 'ANTHROPIC_DEFAULT_SONNET_MODEL',
  };
  for (const [alias, envKey] of Object.entries(map)) {
    if (legacyAliases[alias] && !isNullOrWhiteSpace(legacyAliases[alias])) {
      result[envKey] = String(legacyAliases[alias]);
    }
  }
  return result;
}

/**
 * 从 Profile 提取受管模型 env 键，兼容 modelEnv / 旧版 modelMapping / env 三种来源
 * 对齐 Get-ProviderManagedModelEnv
 */
function getManagedModelEnv(profile) {
  const result = {};
  if (!profile) return result;
  const cfg = RUNTIME_CONFIG;

  if (profile.modelEnv) {
    for (const key of cfg.managedModelEnvKeys) {
      if (!isNullOrWhiteSpace(profile.modelEnv[key])) {
        result[key] = String(profile.modelEnv[key]);
      }
    }
    if (Object.keys(result).length > 0) return result;
  }

  if (profile[cfg.legacyModelKey]) {
    return getManagedModelEnvFromLegacyAliases(profile[cfg.legacyModelKey]);
  }

  if (profile.env) {
    for (const key of cfg.managedModelEnvKeys) {
      if (!isNullOrWhiteSpace(profile.env[key])) {
        result[key] = String(profile.env[key]);
      }
    }
  }

  return result;
}

/**
 * 写入 Profile 的 modelEnv 并清理旧版字段（modelMapping + env 中受管模型键）
 * 对齐 Set-ProviderManagedModelEnv
 */
function setManagedModelEnv(profile, modelEnv) {
  const cfg = RUNTIME_CONFIG;
  delete profile[cfg.legacyModelKey];
  if (profile.env) {
    for (const key of cfg.managedModelEnvKeys) delete profile.env[key];
  }

  if (!modelEnv || Object.keys(modelEnv).length === 0) {
    delete profile.modelEnv;
    return;
  }

  const normalized = {};
  for (const key of cfg.managedModelEnvKeys) {
    if (!isNullOrWhiteSpace(modelEnv[key])) {
      normalized[key] = String(modelEnv[key]);
    }
  }

  if (Object.keys(normalized).length === 0) {
    delete profile.modelEnv;
    return;
  }

  profile.modelEnv = normalized;
}

/** 从 Profile.env 提取受管额外 env 键（对齐 Get-ProviderManagedExtraEnv） */
function getManagedExtraEnv(profile) {
  const result = {};
  if (!profile || !profile.env) return result;
  for (const key of RUNTIME_CONFIG.managedExtraEnvKeys) {
    if (!isNullOrWhiteSpace(profile.env[key])) {
      result[key] = String(profile.env[key]);
    }
  }
  return result;
}

/** 写入 Profile.env 的受管额外 env 键（先清理再写入，对齐 Set-ProviderManagedExtraEnv） */
function setManagedExtraEnv(profile, extraEnv) {
  if (!profile.env) profile.env = {};
  for (const key of RUNTIME_CONFIG.managedExtraEnvKeys) delete profile.env[key];
  if (!extraEnv) return;
  for (const key of RUNTIME_CONFIG.managedExtraEnvKeys) {
    if (!isNullOrWhiteSpace(extraEnv[key])) {
      profile.env[key] = String(extraEnv[key]);
    }
  }
}

/**
 * 合并内置模板默认 ExtraEnv 与 Profile 自身 ExtraEnv（Profile 值优先）
 * 对齐 Get-ProviderEffectiveManagedExtraEnv
 */
function getEffectiveManagedExtraEnv(key, profile) {
  const result = {};
  const builtinKey = getBuiltinProviderKeyFromProfileKey(key);
  if (builtinKey) {
    const template = RUNTIME_CONFIG.builtinProviders[builtinKey];
    if (template && template.extraEnv) {
      for (const [k, v] of Object.entries(template.extraEnv)) {
        if (RUNTIME_CONFIG.managedExtraEnvKeys.includes(k)) result[k] = String(v);
      }
    }
  }
  const profileExtra = getManagedExtraEnv(profile);
  for (const [k, v] of Object.entries(profileExtra)) result[k] = v;
  return result;
}

/** 生成人类可读的模型配置摘要（对齐 Get-ProviderManagedModelSummary） */
function getManagedModelSummary(profile) {
  const modelEnv = getManagedModelEnv(profile);
  if (Object.keys(modelEnv).length === 0) return '未配置';
  const orderedKeys = [
    'ANTHROPIC_DEFAULT_HAIKU_MODEL',
    'ANTHROPIC_DEFAULT_OPUS_MODEL',
    'ANTHROPIC_DEFAULT_SONNET_MODEL',
  ];
  const parts = [];
  for (const key of orderedKeys) {
    if (modelEnv[key]) {
      parts.push(`${RUNTIME_CONFIG.modelEnvLabels[key]}=${modelEnv[key]}`);
    }
  }
  return parts.join(', ');
}

// ============================================================================
// 数据层（settings 读写 / Profile 扫描 / 活跃身份匹配）
// ============================================================================

/** 安全读取 settings.json（对齐 Read-SettingsJson） */
function readSettings() {
  return readJson(SETTINGS_PATH, {}) || {};
}

/** 原子写入 settings.json（对齐 Write-SettingsJsonAtomic） */
function writeSettingsAtomic(settings) {
  return writeJsonAtomic(SETTINGS_PATH, settings);
}

/**
 * 扫描 ~/.claude/providers/*.json，返回 Profile 对象数组
 * 对齐 Get-ProviderProfiles
 */
function getProviderList() {
  if (!fs.existsSync(PROVIDERS_DIR)) return [];
  let files = [];
  try {
    files = fs.readdirSync(PROVIDERS_DIR).filter((f) => f.endsWith('.json'));
  } catch (e) {
    return [];
  }

  const results = [];
  for (const f of files) {
    try {
      const profilePath = path.join(PROVIDERS_DIR, f);
      const profile = readJson(profilePath, null);
      if (!profile || !profile._meta) continue;

      const meta = profile._meta;
      results.push({
        key: path.basename(f, '.json'),
        name: meta.provider || '未知',
        baseUrl: meta.baseUrl || '',
        configuredAt: meta.configuredAt || '',
        hasManagedModelConfig: Object.keys(getManagedModelEnv(profile)).length > 0,
        authToken: (profile.env && profile.env.ANTHROPIC_AUTH_TOKEN) ? profile.env.ANTHROPIC_AUTH_TOKEN : '',
        profilePath,
      });
    } catch (e) { /* 跳过损坏的 Profile 文件 */ }
  }
  return results;
}

/**
 * 从 Profile 列表解析当前活跃供应商（BaseUrl + Token 精确身份匹配）
 * 对齐 Resolve-ActiveProviderProfile
 */
function resolveActiveProfile(profiles, baseUrl, authToken) {
  if (!profiles || profiles.length === 0 || isNullOrWhiteSpace(baseUrl)) return null;

  const baseMatches = profiles.filter((p) => testProviderBaseUrlMatch(baseUrl, p.baseUrl));
  if (baseMatches.length === 0) return null;

  const tokenMatches = baseMatches.filter((p) => testProviderAuthTokenMatch(authToken, p.authToken));
  if (tokenMatches.length > 0) return tokenMatches[0];

  // 兼容旧 Profile / 手工半配置：仅当缺少可比较 Token 时退回历史 BaseUrl 匹配
  const profilesWithToken = baseMatches.filter((p) => !isNullOrWhiteSpace(p.authToken));
  if (isNullOrWhiteSpace(authToken) || profilesWithToken.length === 0) {
    return baseMatches[0];
  }

  return null;
}

/**
 * 识别当前活跃供应商（对齐 Get-ActiveProvider）
 * @returns {{key,name,baseUrl,profilePath}|null}
 */
function getActiveProvider() {
  const settings = readSettings();
  let baseUrl = '';
  let authToken = '';
  if (settings.env) {
    baseUrl = settings.env.ANTHROPIC_BASE_URL || '';
    authToken = settings.env.ANTHROPIC_AUTH_TOKEN || '';
  }
  if (isNullOrWhiteSpace(baseUrl)) return null;

  const profiles = getProviderList();
  const active = resolveActiveProfile(profiles, baseUrl, authToken);
  if (!active) return null;
  return {
    key: active.key,
    name: active.name,
    baseUrl: active.baseUrl,
    profilePath: active.profilePath,
  };
}

/**
 * 聚合供应商展示数据（合并 Profiles + ActiveKey，避免循环中重复扫描）
 * 对齐 Get-ProviderDisplayData
 * @returns {{profiles:Array, activeKey:string, hasProviders:boolean}}
 */
function getDisplayData() {
  const profiles = getProviderList();
  const settings = readSettings();
  let baseUrl = '';
  let authToken = '';
  if (settings.env) {
    baseUrl = settings.env.ANTHROPIC_BASE_URL || '';
    authToken = settings.env.ANTHROPIC_AUTH_TOKEN || '';
  }
  const active = resolveActiveProfile(profiles, baseUrl, authToken);
  const activeKey = active ? active.key : '';

  const displayProfiles = profiles.map((p) => ({
    key: p.key,
    name: p.name,
    baseUrl: p.baseUrl,
    authToken: p.authToken,
    profilePath: p.profilePath,
    isActive: !!activeKey && p.key === activeKey,
    maskedApiKey: maskApiKey(p.authToken),
  }));

  return {
    profiles: displayProfiles,
    activeKey,
    hasProviders: displayProfiles.length > 0,
  };
}

// ============================================================================
// 变更层（sync / add / edit / delete / switch）
// 所有公开函数用 withProfileLock 包裹；内部用 *Unlocked 避免重入死锁
// ============================================================================

/**
 * 从 settings.json 反向生成 Profile（迁移旧用户场景）
 * 对齐 Sync-ProviderFromSettings
 * @returns {{synced:boolean, reason?:string, key?:string, name?:string}}
 */
function syncFromSettingsUnlocked() {
  const settings = readSettings();
  const authToken = (settings.env && settings.env.ANTHROPIC_AUTH_TOKEN) || '';
  const baseUrl = (settings.env && settings.env.ANTHROPIC_BASE_URL) || '';
  if (isNullOrWhiteSpace(authToken) || isNullOrWhiteSpace(baseUrl)) {
    return { synced: false, reason: 'no-active-provider' };
  }

  // 扫描现有 Profile → 精确匹配则跳过
  if (fs.existsSync(PROVIDERS_DIR)) {
    const profiles = getProviderList();
    for (const p of profiles) {
      if (testProviderBaseUrlMatch(baseUrl, p.baseUrl) && testProviderAuthTokenMatch(authToken, p.authToken)) {
        return { synced: false, reason: 'already-exists', key: p.key };
      }
    }
  }

  const cfg = RUNTIME_CONFIG;
  let migrateKey = 'custom';
  let providerName = '自定义供应商';
  for (const [k, p] of Object.entries(cfg.builtinProviders)) {
    if (k === 'custom') continue;
    if (testProviderBaseUrlMatch(baseUrl, p.baseUrl)) {
      migrateKey = k;
      providerName = p.name;
      break;
    }
  }

  // 自定义供应商统一 key 生成（名称/URL 回退，含路径哈希消歧）
  if (migrateKey === 'custom' && !isNullOrWhiteSpace(baseUrl)) {
    migrateKey = newCustomProviderKey('', baseUrl);
    if (!testProviderKey(migrateKey)) migrateKey = 'custom-unknown';
  }

  // 同 BaseUrl 但 Token 不同的配置保留为独立 Profile，避免覆盖
  if (fs.existsSync(path.join(PROVIDERS_DIR, `${migrateKey}.json`))) {
    migrateKey = getNextAvailableKey(migrateKey, PROVIDERS_DIR);
  }

  const newProfile = {
    _meta: {
      provider: providerName,
      key: migrateKey,
      baseUrl,
      configuredAt: new Date().toISOString(),
    },
    env: {
      ANTHROPIC_AUTH_TOKEN: authToken,
      ANTHROPIC_BASE_URL: baseUrl,
    },
  };

  // 兼容迁移：从 settings 顶层 modelMapping / env 受管模型键同步到 Profile
  const managedModelEnv = {};
  if (settings[cfg.legacyModelKey]) {
    Object.assign(managedModelEnv, getManagedModelEnvFromLegacyAliases(settings[cfg.legacyModelKey]));
  }
  if (settings.env) {
    for (const k of cfg.managedModelEnvKeys) {
      if (!isNullOrWhiteSpace(settings.env[k])) managedModelEnv[k] = String(settings.env[k]);
    }
  }
  setManagedModelEnv(newProfile, managedModelEnv);

  // 兼容迁移：内置供应商先带入默认额外 env，再允许 settings 已有值覆盖
  const managedExtraEnv = {};
  if (cfg.builtinProviders[migrateKey] && cfg.builtinProviders[migrateKey].extraEnv) {
    for (const [k, v] of Object.entries(cfg.builtinProviders[migrateKey].extraEnv)) {
      managedExtraEnv[k] = String(v);
    }
  }
  if (settings.env) {
    for (const k of cfg.managedExtraEnvKeys) {
      if (!isNullOrWhiteSpace(settings.env[k])) managedExtraEnv[k] = String(settings.env[k]);
    }
  }
  setManagedExtraEnv(newProfile, managedExtraEnv);

  // 原子写入 Profile
  if (!fs.existsSync(PROVIDERS_DIR)) fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
  writeJsonAtomic(path.join(PROVIDERS_DIR, `${migrateKey}.json`), newProfile);

  return { synced: true, key: migrateKey, name: providerName };
}

/**
 * 切换活跃供应商（读 Profile → 合并 settings.json，严格字段所有权）
 * 不写 $PROFILE（ccq 函数固定，对齐 Provider.ps1 Switch-Provider 实际行为）
 * 对齐 Switch-Provider（HC-SETTINGS-OWNERSHIP）
 */
function switchProviderUnlocked(key) {
  const profiles = getProviderList();
  if (profiles.length === 0) throw new Error('未找到供应商 Profile，请先添加供应商');
  if (!testProviderKey(key)) throw new Error(`非法 Provider Key: ${key}`);

  const profilePath = path.join(PROVIDERS_DIR, `${key}.json`);
  if (!fs.existsSync(profilePath)) throw new Error(`供应商 Profile 不存在: ${key}`);

  const profile = readJson(profilePath, null);
  if (!profile) throw new Error(`供应商 Profile 读取失败: ${key}`);

  const settings = readSettings();
  if (!settings.env) settings.env = {};

  // 1. AUTH_TOKEN + BASE_URL（仅来自 profile.env）
  if (profile.env) {
    if (!isNullOrWhiteSpace(profile.env.ANTHROPIC_AUTH_TOKEN)) {
      settings.env.ANTHROPIC_AUTH_TOKEN = profile.env.ANTHROPIC_AUTH_TOKEN;
    }
    if (!isNullOrWhiteSpace(profile.env.ANTHROPIC_BASE_URL)) {
      settings.env.ANTHROPIC_BASE_URL = profile.env.ANTHROPIC_BASE_URL;
    }
  }

  const cfg = RUNTIME_CONFIG;

  // 2. 清理旧版顶层别名映射字段，避免新旧并存
  delete settings[cfg.legacyModelKey];

  // 3. 先清理所有受管模型键，再写入当前 Profile 的模型配置
  for (const modelEnvKey of cfg.managedModelEnvKeys) delete settings.env[modelEnvKey];
  const managedModelEnv = getManagedModelEnv(profile);
  for (const [k, v] of Object.entries(managedModelEnv)) settings.env[k] = v;

  // 4. 清理并写入供应商受管额外 env，避免切换后残留
  for (const extraEnvKey of cfg.managedExtraEnvKeys) delete settings.env[extraEnvKey];
  const managedExtraEnv = getEffectiveManagedExtraEnv(key, profile);
  for (const [k, v] of Object.entries(managedExtraEnv)) settings.env[k] = v;

  // ★ 绝不触碰：model / language / permissions / hooks / statusLine / mcpServers
  writeSettingsAtomic(settings);

  const providerName = (profile._meta && profile._meta.provider) ? profile._meta.provider : key;
  return { success: true, providerName };
}

/**
 * 添加供应商（非交互核心）
 * @param {Object} opts
 *   - builtinKey: 内置供应商 key（zhipu/minimax/moonshot/deepseek/bailian）；提供时走内置分支
 *   - name: 显示名称（可选，内置默认取模板，自定义默认"自定义供应商"）
 *   - baseUrl: 自定义供应商必填
 *   - apiKey: 必填
 *   - modelEnv: 自定义/需手动配置模型时提供（受管键子集）
 *   - extraEnv: 自定义额外 env（受管键子集）
 *   - activate: 添加后是否立即激活
 *   - conflictStrategy: 'increment'(默认，内置) | 'overwrite'(默认，自定义) | 'error'
 * @returns {{success, key, name, baseUrl, activated?, error?, activateError?}}
 */
function addProviderUnlocked(opts) {
  const cfg = RUNTIME_CONFIG;
  const result = { success: false, key: '', name: '', baseUrl: '', activated: false };

  if (!opts || isNullOrWhiteSpace(opts.apiKey)) {
    result.error = 'API Key 不能为空';
    return result;
  }

  const conflictStrategy = opts.conflictStrategy; // undefined → 按 isBuiltin 默认
  let selectedKey;
  let providerName;
  let providerBaseUrl;
  let template = null;

  if (opts.builtinKey && cfg.builtinProviders[opts.builtinKey] && opts.builtinKey !== 'custom') {
    // 内置供应商
    template = cfg.builtinProviders[opts.builtinKey];
    selectedKey = opts.builtinKey;
    providerName = opts.name || template.name;
    providerBaseUrl = template.baseUrl;

    const strategy = conflictStrategy || 'increment';
    const exists = fs.existsSync(path.join(PROVIDERS_DIR, `${selectedKey}.json`));
    const hasBuiltinCopies = findBuiltinProviderProfiles(selectedKey, getProviderList()).length > 0;
    if (exists || hasBuiltinCopies) {
      if (strategy === 'error') {
        result.error = `供应商 ${selectedKey} 已存在`;
        return result;
      }
      if (strategy === 'increment') {
        selectedKey = getNextAvailableKey(selectedKey, PROVIDERS_DIR);
        const numMatch = selectedKey.match(/-(\d+)$/);
        const num = numMatch ? parseInt(numMatch[1], 10) : 2;
        providerName = opts.name || `${template.name} (${num})`;
      }
      // strategy === 'overwrite' → 保持 selectedKey，后续覆盖写入
    }
  } else {
    // 自定义供应商
    if (isNullOrWhiteSpace(opts.baseUrl)) {
      result.error = 'Base URL 不能为空';
      return result;
    }
    if (!/^https?:\/\//.test(String(opts.baseUrl))) {
      result.error = 'Base URL 必须以 http:// 或 https:// 开头';
      return result;
    }
    providerBaseUrl = String(opts.baseUrl).replace(/\/+$/, '');
    providerName = opts.name || '自定义供应商';
    selectedKey = newCustomProviderKey(opts.name, providerBaseUrl);
    if (!testProviderKey(selectedKey)) {
      result.error = '生成的 Provider Key 非法';
      return result;
    }
    const exists = fs.existsSync(path.join(PROVIDERS_DIR, `${selectedKey}.json`));
    if (exists) {
      const strategy = conflictStrategy || 'overwrite';
      if (strategy === 'error') {
        result.error = `供应商 ${selectedKey} 已存在`;
        return result;
      }
      // increment / overwrite 由调用方语义决定；默认 overwrite
    }
  }

  // 构建 Profile
  const profile = {
    _meta: {
      provider: providerName,
      key: selectedKey,
      baseUrl: providerBaseUrl,
      configuredAt: new Date().toISOString(),
    },
    env: {
      ANTHROPIC_AUTH_TOKEN: String(opts.apiKey),
      ANTHROPIC_BASE_URL: providerBaseUrl,
    },
  };

  // 模型 env：内置模板优先，否则取 opts.modelEnv
  if (template && template.modelEnv) {
    setManagedModelEnv(profile, template.modelEnv);
  } else if (opts.modelEnv) {
    setManagedModelEnv(profile, opts.modelEnv);
  }

  // 额外 env：内置模板优先，否则取 opts.extraEnv
  if (template && template.extraEnv) {
    setManagedExtraEnv(profile, template.extraEnv);
  } else if (opts.extraEnv) {
    setManagedExtraEnv(profile, opts.extraEnv);
  }

  // 原子写入 Profile
  if (!fs.existsSync(PROVIDERS_DIR)) fs.mkdirSync(PROVIDERS_DIR, { recursive: true });
  writeJsonAtomic(path.join(PROVIDERS_DIR, `${selectedKey}.json`), profile);

  result.success = true;
  result.key = selectedKey;
  result.name = providerName;
  result.baseUrl = providerBaseUrl;

  // 激活（锁内直接调用 Unlocked 版本，避免重入）
  if (opts.activate) {
    try {
      switchProviderUnlocked(selectedKey);
      result.activated = true;
    } catch (e) {
      result.activateError = e.message;
    }
  }

  return result;
}

/**
 * 修改供应商配置（非交互核心）
 * @param {string} key Provider Key
 * @param {Object} updates { apiKey?, baseUrl?, name?, modelEnv? }
 *   - modelEnv: null 表示清除全部模型配置
 * 活跃供应商修改后自动同步 settings.json
 * 对齐 Edit-Provider
 */
function editProviderUnlocked(key, updates) {
  if (!testProviderKey(key)) throw new Error(`非法 Provider Key: ${key}`);
  const profilePath = path.join(PROVIDERS_DIR, `${key}.json`);
  if (!fs.existsSync(profilePath)) throw new Error(`供应商 Profile 不存在: ${key}`);

  const profile = readJson(profilePath, null);
  if (!profile) throw new Error(`供应商 Profile 读取失败: ${key}`);
  if (!profile._meta) profile._meta = {};
  if (!profile.env) profile.env = {};

  const meta = profile._meta;
  const envData = profile.env;

  // 写入前判断是否活跃（写入后 BaseUrl 可能已变，无法再匹配旧 URL）
  const activeBefore = getActiveProvider();
  const wasActive = !!(activeBefore && activeBefore.key === key);

  let pendingNewKey = null;

  if (updates.apiKey !== undefined) {
    if (isNullOrWhiteSpace(updates.apiKey)) throw new Error('API Key 不能为空');
    envData.ANTHROPIC_AUTH_TOKEN = String(updates.apiKey);
  }
  if (updates.baseUrl !== undefined) {
    if (isNullOrWhiteSpace(updates.baseUrl) || !/^https?:\/\//.test(String(updates.baseUrl))) {
      throw new Error('Base URL 无效');
    }
    const newUrl = String(updates.baseUrl).replace(/\/+$/, '');
    meta.baseUrl = newUrl;
    envData.ANTHROPIC_BASE_URL = newUrl;
  }
  if (updates.name !== undefined) {
    if (isNullOrWhiteSpace(updates.name)) throw new Error('名称不能为空');
    meta.provider = String(updates.name).trim();
    // 自定义供应商：同步重命名文件 key（从名称重新派生）
    if (/^custom-/.test(key)) {
      const candidateKey = newCustomProviderKey(updates.name, meta.baseUrl);
      if (testProviderKey(candidateKey) && candidateKey !== key) {
        const candidatePath = path.join(PROVIDERS_DIR, `${candidateKey}.json`);
        if (!fs.existsSync(candidatePath)) pendingNewKey = candidateKey;
      }
    }
  }
  if (updates.modelEnv !== undefined) {
    setManagedModelEnv(profile, updates.modelEnv);
  }

  const effectiveKey = pendingNewKey || key;
  if (pendingNewKey) meta.key = pendingNewKey;

  // 原子写入（重命名场景：写新文件 + 删旧文件）
  if (pendingNewKey) {
    const newPath = path.join(PROVIDERS_DIR, `${pendingNewKey}.json`);
    writeJsonAtomic(newPath, profile);
    try { fs.unlinkSync(profilePath); } catch (e) { /* 旧文件清理失败不阻塞 */ }
  } else {
    writeJsonAtomic(profilePath, profile);
  }

  // 活跃供应商自动同步 settings.json
  if (wasActive) {
    switchProviderUnlocked(effectiveKey);
  }

  return { success: true, key: effectiveKey, renamed: pendingNewKey !== null };
}

/**
 * 删除供应商 Profile
 * @param {string} key Provider Key
 * @param {Object} opts { force?: boolean } force=true 允许删除活跃供应商（同时清理 settings 引用）
 * 对齐 Remove-Provider
 */
function deleteProviderUnlocked(key, opts) {
  opts = opts || {};
  if (!testProviderKey(key)) throw new Error(`非法 Provider Key: ${key}`);
  const profilePath = path.join(PROVIDERS_DIR, `${key}.json`);
  if (!fs.existsSync(profilePath)) throw new Error(`供应商 Profile 不存在: ${key}`);

  const active = getActiveProvider();
  const isActive = !!(active && active.key === key);

  // 活跃供应商保护
  if (isActive && !opts.force) {
    throw new Error(`无法删除当前活跃的供应商: ${active.name}，请先切换到其他供应商后再删除`);
  }

  fs.unlinkSync(profilePath);

  // 删除活跃供应商（force 模式）：清理 settings.json 残留引用
  if (isActive) {
    const settings = readSettings();
    if (settings.env) {
      delete settings.env.ANTHROPIC_AUTH_TOKEN;
      delete settings.env.ANTHROPIC_BASE_URL;
      for (const k of RUNTIME_CONFIG.managedModelEnvKeys) delete settings.env[k];
      for (const k of RUNTIME_CONFIG.managedExtraEnvKeys) delete settings.env[k];
    }
    delete settings[RUNTIME_CONFIG.legacyModelKey];
    writeSettingsAtomic(settings);
  }

  return { success: true, key, clearedSettings: isActive };
}

// 公开版本：用 withProfileLock 包裹
function syncFromSettings() {
  return withProfileLock(() => syncFromSettingsUnlocked());
}
function switchProvider(key) {
  return withProfileLock(() => switchProviderUnlocked(key));
}
function addProvider(opts) {
  return withProfileLock(() => addProviderUnlocked(opts));
}
function editProvider(key, updates) {
  return withProfileLock(() => editProviderUnlocked(key, updates));
}
function deleteProvider(key, opts) {
  return withProfileLock(() => deleteProviderUnlocked(key, opts));
}

// ============================================================================
// Profile 标记块工具（design D5，供 Phase 3 Update / Phase 4 ccq 集成复用）
// ============================================================================

/**
 * 更新 Profile 文件中的受管标记块（fs + 正则替换 + 原子写入）
 * 标记块不存在时追加，存在时整体替换
 * 对齐 design D5 updateProfileMarker + Profile.ps1 Set-ManagedBlockInFile
 * @param {string} profilePath Profile 文件路径（$PROFILE / ~/.zshrc）
 * @param {string} newContent 标记块内部内容（不含标记行本身）
 */
function updateProfileMarker(profilePath, newContent) {
  const current = fs.existsSync(profilePath) ? fs.readFileSync(profilePath, 'utf8') : '';
  const markerRegex = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`);
  const newBlock = `${MARKER_START}\n${newContent}\n${MARKER_END}`;

  let updated;
  if (markerRegex.test(current)) {
    updated = current.replace(markerRegex, newBlock);
  } else {
    const sep = current && !current.endsWith('\n') ? '\n\n' : (current ? '\n' : '');
    updated = current + sep + newBlock + '\n';
  }

  return atomicWrite(profilePath, updated);
}

/** 检测 Profile 是否含受管标记块（对齐 Test-ManagedBlockExists） */
function hasProfileMarker(profilePath) {
  if (!fs.existsSync(profilePath)) return false;
  const current = fs.readFileSync(profilePath, 'utf8');
  const markerRegex = new RegExp(`${escapeRegex(MARKER_START)}[\\s\\S]*?${escapeRegex(MARKER_END)}`);
  return markerRegex.test(current);
}

// ============================================================================
// 入口层（Phase 1a：--version / status / list；TUI Dashboard 待 Phase 1b）
// ============================================================================

async function main() {
  const args = process.argv.slice(2);
  const action = args[0];

  try {
    if (action === '--version') {
      console.log(SCRIPT_VERSION);
      cleanupGlobalTTY();
      process.exit(0);
    }

    // 机器可读状态输出（供调试 / 单元测试 / 上层调用）
    if (action === 'status' || action === 'list') {
      console.log(JSON.stringify(getDisplayData(), null, 2));
      cleanupGlobalTTY();
      process.exit(0);
    }

    if (action === 'active') {
      console.log(JSON.stringify(getActiveProvider(), null, 2));
      cleanupGlobalTTY();
      process.exit(0);
    }

    // Phase 1a 占位（TUI Dashboard / 交互式 CRUD 待 Phase 1b）
    console.log(colorize('═══════════════════════════════════════════', 'primary'));
    console.log(colorize('           Provider 供应商管理              ', 'primary'));
    console.log(colorize('═══════════════════════════════════════════', 'primary'));
    console.log('');
    console.log(colorize('ℹ️  Phase 1a 核心逻辑已就绪（CRUD + Switch + 字段所有权）', 'info'));
    console.log(colorize('   交互式 TUI Dashboard 待 Phase 1b 接入', 'dim'));
    console.log('');
    console.log(colorize('可用命令:', 'info'));
    console.log(colorize('  node provider-manager.js status    查看供应商状态（JSON）', 'dim'));
    console.log(colorize('  node provider-manager.js active    查看活跃供应商（JSON）', 'dim'));
    console.log(colorize('  node provider-manager.js --version 查看版本', 'dim'));
    console.log('');

    cleanupGlobalTTY();
    process.exit(0);
  } catch (err) {
    console.error(colorize(`❌ ${err.message}`, 'danger'));
    cleanupGlobalTTY();
    process.exit(1);
  }
}

// 注册退出清理
process.on('exit', cleanupGlobalTTY);
process.on('SIGINT', () => { cleanupGlobalTTY(); process.exit(130); });
process.on('SIGTERM', () => { cleanupGlobalTTY(); process.exit(143); });

if (require.main === module) {
  main().catch((err) => {
    console.error(colorize(`❌ 未捕获异常: ${err.message}`, 'danger'));
    cleanupGlobalTTY();
    process.exit(1);
  });
}

// ============================================================================
// 导出（供 manage.js 路由 / 单元测试 / Phase 1b TUI 复用）
// ============================================================================
module.exports = {
  SCRIPT_VERSION,
  // 契约层
  loadProviderContract,
  normalizeContract,
  INLINE_PROVIDER_CONFIG,
  // 工具层
  readJson,
  writeJsonAtomic,
  isNullOrWhiteSpace,
  maskApiKey,
  normalizeBaseUrl,
  testProviderBaseUrlMatch,
  testProviderAuthTokenMatch,
  testProviderKey,
  newCustomProviderKey,
  getNextAvailableKey,
  findBuiltinProviderProfiles,
  getBuiltinProviderKeyFromProfileKey,
  // 受管 env 层
  getManagedModelEnvFromLegacyAliases,
  getManagedModelEnv,
  setManagedModelEnv,
  getManagedExtraEnv,
  setManagedExtraEnv,
  getEffectiveManagedExtraEnv,
  getManagedModelSummary,
  // 数据层
  readSettings,
  writeSettingsAtomic,
  getProviderList,
  resolveActiveProfile,
  getActiveProvider,
  getDisplayData,
  // 变更层（公开，自动加锁）
  syncFromSettings,
  addProvider,
  editProvider,
  deleteProvider,
  switchProvider,
  // 变更层（Unlocked，仅供同进程持锁调用 / 测试）
  syncFromSettingsUnlocked,
  addProviderUnlocked,
  editProviderUnlocked,
  deleteProviderUnlocked,
  switchProviderUnlocked,
  // Profile 标记块
  updateProfileMarker,
  hasProfileMarker,
  MARKER_START,
  MARKER_END,
};
