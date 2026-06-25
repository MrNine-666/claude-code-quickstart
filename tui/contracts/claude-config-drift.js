#!/usr/bin/env node
/**
 * claude-config-drift.js — ClaudeConfig 漂移检测与声明式对齐
 *
 * 用途：跨平台统一检测 settings.json 与 claude-config.json 契约的漂移，并提供声明式合并。
 * 模式：
 *   - analyze: 只检测漂移，返回 { hasDrift, needsInstallCompletion, needsUpdateAlignment, details }
 *   - install: 补缺失项（仅添加，不覆盖已有值）
 *   - update: 声明式对齐（更新偏移值 + 补缺失项 + 删除废弃键）
 *
 * 禁区保护：DoNotManageTopLevelKeys / DoNotManageEnvKeys 不触碰
 */

const fs = require('fs');
const crypto = require('crypto');

// ─── 参数解析 ─────────────────────────────────────────────────────────────────

function parseArgs() {
  const args = process.argv.slice(2);
  const parsed = { contractPath: '', settingsPath: '', mode: 'analyze' };

  for (let i = 0; i < args.length; i++) {
    if (args[i] === '--contract-path' && i + 1 < args.length) {
      parsed.contractPath = args[++i];
    } else if (args[i] === '--settings-path' && i + 1 < args.length) {
      parsed.settingsPath = args[++i];
    } else if (args[i] === '--mode' && i + 1 < args.length) {
      parsed.mode = args[++i];
    }
  }

  if (!parsed.contractPath || !parsed.settingsPath) {
    console.error('Usage: claude-config-drift.js --contract-path <path> --settings-path <path> [--mode analyze|install|update]');
    process.exit(1);
  }

  if (!['analyze', 'install', 'update'].includes(parsed.mode)) {
    console.error('Invalid mode. Must be: analyze, install, or update');
    process.exit(1);
  }

  return parsed;
}

// ─── 工具函数 ─────────────────────────────────────────────────────────────────

function isObject(v) {
  return v && typeof v === 'object' && !Array.isArray(v);
}

function isForbiddenEnvKey(key, doNotManageEnvKeys) {
  return doNotManageEnvKeys.includes(key);
}

function isForbiddenTopLevelKey(key, doNotManageTopLevelKeys) {
  return doNotManageTopLevelKeys.includes(key);
}

// ─── analyze 模式：检测漂移 ───────────────────────────────────────────────────

function analyzeSettings(contract, settings) {
  const result = {
    hasDrift: false,
    needsInstallCompletion: false,
    needsUpdateAlignment: false,
    details: {
      missingEnvKeys: [],
      driftedEnvKeys: [],
      missingPermissions: [],
      deprecatedEnvKeys: [],
      missingLanguage: false,
      missingAlwaysThinkingEnabled: false,
      missingPlansDirectory: false,
      missingAttribution: false,
      parseError: ''
    }
  };

  // 1. 顶层配置检查
  const topLevel = contract.TopLevelDefaults || {};

  if (!settings.language || !String(settings.language).trim()) {
    result.details.missingLanguage = true;
    result.needsInstallCompletion = true;
  }

  if (settings.alwaysThinkingEnabled === undefined || settings.alwaysThinkingEnabled === null) {
    result.details.missingAlwaysThinkingEnabled = true;
    result.needsInstallCompletion = true;
  }

  if (!settings.plansDirectory || !String(settings.plansDirectory).trim()) {
    result.details.missingPlansDirectory = true;
    result.needsInstallCompletion = true;
  } else if (settings.plansDirectory !== topLevel.plansDirectory) {
    result.needsUpdateAlignment = true;
  }

  if (!isObject(settings.attribution)) {
    result.details.missingAttribution = true;
    result.needsInstallCompletion = true;
  }

  // 2. env 键检查
  const env = isObject(settings.env) ? settings.env : {};
  const doNotManageEnvKeys = contract.Ownership?.DoNotManageEnvKeys || [];

  for (const [key, value] of Object.entries(contract.ClaudeConfigEnvDefaults || {})) {
    if (isForbiddenEnvKey(key, doNotManageEnvKeys)) continue;

    if (!env[key] || !String(env[key]).trim()) {
      result.details.missingEnvKeys.push(key);
      result.needsInstallCompletion = true;
    } else if (String(env[key]) !== String(value)) {
      result.details.driftedEnvKeys.push({ key, expected: value, actual: env[key] });
      result.needsUpdateAlignment = true;
    }
  }

  // 3. 废弃键检查
  for (const key of contract.ClaudeConfigDeprecatedEnvKeys || []) {
    if (isForbiddenEnvKey(key, doNotManageEnvKeys)) continue;
    if (Object.prototype.hasOwnProperty.call(env, key)) {
      result.details.deprecatedEnvKeys.push(key);
      result.needsUpdateAlignment = true;
    }
  }

  // 4. permissions 检查
  const permissions = isObject(settings.permissions) ? settings.permissions : {};
  const allow = Array.isArray(permissions.allow) ? permissions.allow : [];

  for (const perm of contract.ClaudeConfigBasePermissions || []) {
    if (!allow.includes(perm)) {
      result.details.missingPermissions.push(perm);
      result.needsInstallCompletion = true;
    }
  }

  result.hasDrift = result.needsInstallCompletion || result.needsUpdateAlignment;
  return result;
}

// ─── install / update 模式：应用变更 ──────────────────────────────────────────

function applySettings(contract, settings, mode) {
  const updatedItems = [];
  const doNotManageEnvKeys = contract.Ownership?.DoNotManageEnvKeys || [];
  const doNotManageTopLevelKeys = contract.Ownership?.DoNotManageTopLevelKeys || [];

  // 1. env 键处理
  if (!isObject(settings.env)) {
    settings.env = {};
    updatedItems.push('config::env::section-added');
  }

  for (const [key, value] of Object.entries(contract.ClaudeConfigEnvDefaults || {})) {
    if (isForbiddenEnvKey(key, doNotManageEnvKeys)) continue;

    if (mode === 'update') {
      // update 模式：声明式对齐（更新偏移值 + 补缺失）
      if (settings.env[key] !== String(value)) {
        updatedItems.push(settings.env[key] === undefined ? `config::env.${key}::added` : `config::env.${key}::updated`);
        settings.env[key] = String(value);
      }
    } else {
      // install 模式：只补缺失
      if (settings.env[key] === undefined || settings.env[key] === null || !String(settings.env[key]).trim()) {
        settings.env[key] = String(value);
        updatedItems.push(`config::env.${key}::added`);
      }
    }
  }

  // 2. 废弃键删除（仅 update 模式）
  if (mode === 'update') {
    for (const key of contract.ClaudeConfigDeprecatedEnvKeys || []) {
      if (isForbiddenEnvKey(key, doNotManageEnvKeys)) continue;
      if (Object.prototype.hasOwnProperty.call(settings.env, key)) {
        delete settings.env[key];
        updatedItems.push(`config::env.${key}::removed`);
      }
    }
  }

  // 3. 顶层配置处理
  for (const [key, value] of Object.entries(contract.TopLevelDefaults || {})) {
    if (isForbiddenTopLevelKey(key, doNotManageTopLevelKeys)) continue;

    if (key === 'attribution') {
      if (!isObject(settings.attribution)) {
        settings.attribution = value;
        updatedItems.push('config::attribution::added');
      }
      continue;
    }

    const missing = settings[key] === undefined || settings[key] === null || (typeof settings[key] === 'string' && !settings[key].trim());

    if (missing || (mode === 'update' && key === 'plansDirectory' && settings[key] !== value)) {
      settings[key] = value;
      updatedItems.push(`config::${key}::${missing ? 'added' : 'updated'}`);
    }
  }

  // 4. permissions 处理
  if (!isObject(settings.permissions)) {
    settings.permissions = {};
    updatedItems.push('config::permissions::section-added');
  }
  if (!Array.isArray(settings.permissions.allow)) {
    settings.permissions.allow = [];
    updatedItems.push('config::permissions.allow::section-added');
  }

  // 去重 + 合并
  const allow = [];
  for (const perm of settings.permissions.allow) {
    if (typeof perm === 'string' && perm.trim() && !allow.includes(perm)) {
      allow.push(perm);
    }
  }
  for (const perm of contract.ClaudeConfigBasePermissions || []) {
    if (!allow.includes(perm)) {
      allow.push(perm);
      updatedItems.push(`config::permissions.allow.${perm}::added`);
    }
  }
  settings.permissions.allow = allow;

  if (!Array.isArray(settings.permissions.deny)) {
    settings.permissions.deny = [];
  }

  return { newSettings: settings, updatedItems };
}

// ─── 主入口 ───────────────────────────────────────────────────────────────────

function main() {
  const args = parseArgs();

  // 读取契约
  let contract;
  try {
    contract = JSON.parse(fs.readFileSync(args.contractPath, 'utf8'));
  } catch (error) {
    console.error(JSON.stringify({ error: 'contract-read-failed', message: error.message }));
    process.exit(1);
  }

  // 读取 settings
  let settings = {};
  let parseError = '';

  if (!fs.existsSync(args.settingsPath)) {
    if (args.mode === 'analyze') {
      const result = {
        hasDrift: true,
        needsInstallCompletion: true,
        needsUpdateAlignment: false,
        details: {
          missingEnvKeys: Object.keys(contract.ClaudeConfigEnvDefaults || {}),
          driftedEnvKeys: [],
          missingPermissions: contract.ClaudeConfigBasePermissions || [],
          deprecatedEnvKeys: [],
          missingLanguage: true,
          missingAlwaysThinkingEnabled: true,
          missingPlansDirectory: true,
          missingAttribution: true,
          parseError: ''
        }
      };
      console.log(JSON.stringify(result, null, 2));
      return;
    }
  } else {
    try {
      const raw = fs.readFileSync(args.settingsPath, 'utf8').trim();
      if (raw) settings = JSON.parse(raw);
    } catch (error) {
      parseError = error.message;
      if (args.mode === 'analyze') {
        console.log(JSON.stringify({
          hasDrift: true,
          needsInstallCompletion: true,
          needsUpdateAlignment: false,
          details: { parseError }
        }, null, 2));
        return;
      }
      // install/update 模式遇到解析错误则重置为空对象
      settings = {};
    }
  }

  // 执行对应模式
  if (args.mode === 'analyze') {
    const result = analyzeSettings(contract, settings);
    console.log(JSON.stringify(result, null, 2));
  } else {
    const applied = applySettings(contract, settings, args.mode);
    const result = {
      hasDrift: false,
      needsInstallCompletion: false,
      needsUpdateAlignment: false,
      details: {},
      applied: {
        newSettings: applied.newSettings,
        updatedItems: applied.updatedItems.length ? applied.updatedItems : ['noop::ClaudeConfig::no-change']
      }
    };
    console.log(JSON.stringify(result, null, 2));
  }
}

main();
