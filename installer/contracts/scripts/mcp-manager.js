#!/usr/bin/env node
/**
 * MCP Manager - Cross-platform MCP management core algorithms
 *
 * This script provides pure data processing functions for MCP management,
 * shared by both Windows PowerShell and macOS zsh platforms.
 *
 * Design principles:
 * - Pure data transformation, no platform-specific I/O
 * - No interactive prompts (handled by platform layer)
 * - No dependency installation (handled by platform layer)
 * - Input/output via JSON for cross-platform compatibility
 *
 * Usage modes:
 * - status: Compute MCP server status
 * - sync-credentials: Sync credentials between .claude.json and vault
 * - state-update: Update server state (disable/enable/remove)
 * - build-entry: Build MCP server config entry
 * - definition-hash: Compute definition hash
 * - sync-rules: Render MCP rules files
 */

const fs = require('fs');
const path = require('path');
const crypto = require('crypto');

// ============================================================================
// Utilities
// ============================================================================

/**
 * Safe JSON parse with fallback
 */
function safeJsonParse(filePath, fallback = null) {
  try {
    if (!fs.existsSync(filePath)) return fallback;
    const content = fs.readFileSync(filePath, 'utf8');
    return JSON.parse(content);
  } catch (err) {
    return fallback;
  }
}

/**
 * Compute definition hash (8-char hex)
 * Excludes non-runtime fields: Description, Category, Priority, Recommended, Name, RuntimeDeps
 */
function computeDefinitionHash(serverDef) {
  const runtimeFields = {
    ServerId: serverDef.ServerId,
    Type: serverDef.Type,
    Config: serverDef.Config,
    CredentialFields: serverDef.CredentialFields,
    EnvFile: serverDef.EnvFile,
    PreInstall: serverDef.PreInstall
  };
  const canonical = JSON.stringify(runtimeFields, Object.keys(runtimeFields).sort());
  return crypto.createHash('sha256').update(canonical, 'utf8').digest('hex').substring(0, 8);
}

/**
 * Determine server status
 * Priority: Custom > Active > Disabled > Missing > Unknown
 */
function determineStatus(serverId, claudeJson, metaJson, contract) {
  const inClaude = claudeJson?.mcpServers?.[serverId];
  const inMeta = metaJson?.servers?.[serverId];
  const inContract = contract?.servers?.find(s => s.ServerId === serverId);

  // Custom: in .claude.json but not in contract
  if (inClaude && !inContract) return 'Custom';

  // Active: in .claude.json and in contract
  if (inClaude && inContract) return 'Active';

  // Disabled: not in .claude.json but in vault
  if (!inClaude && inMeta) return 'Disabled';

  // Missing: in contract but not in .claude.json and not in vault
  if (inContract && !inClaude && !inMeta) return 'Missing';

  return 'Unknown';
}

// ============================================================================
// Mode: status
// ============================================================================

function modeStatus(args) {
  const claudeJsonPath = args['claude-json'];
  const metaPath = args['meta-path'];
  const contractPath = args['contract-path'];

  if (!claudeJsonPath || !metaPath || !contractPath) {
    return { error: 'Missing required arguments: --claude-json, --meta-path, --contract-path' };
  }

  const claudeJson = safeJsonParse(claudeJsonPath, {});
  const metaJson = safeJsonParse(metaPath, { servers: {} });
  const contract = safeJsonParse(contractPath, { servers: [] });

  const rows = [];

  // Collect all server IDs from all sources
  const allIds = new Set();
  Object.keys(claudeJson?.mcpServers || {}).forEach(id => allIds.add(id));
  Object.keys(metaJson?.servers || {}).forEach(id => allIds.add(id));
  (contract?.servers || []).forEach(s => allIds.add(s.ServerId));

  // Build status rows
  for (const serverId of allIds) {
    const status = determineStatus(serverId, claudeJson, metaJson, contract);
    const serverDef = contract?.servers?.find(s => s.ServerId === serverId);
    const metaEntry = metaJson?.servers?.[serverId];

    const name = serverDef?.Name || serverId;
    const mcpType = serverDef ? (serverDef.Type === 'npx' ? 'NPX' : serverDef.Type === 'stdio' ? 'STDIO' : 'UNKNOWN') : 'CUSTOM';
    const category = serverDef?.Category || '-';

    // Check credentials
    let hasCredentials = '-';
    if (status === 'Active') {
      const claudeEntry = claudeJson.mcpServers[serverId];
      if (claudeEntry?.env && Object.keys(claudeEntry.env).length > 0) {
        hasCredentials = '有';
      }
    } else if (status === 'Disabled') {
      if (metaEntry?.credentials && Object.keys(metaEntry.credentials).length > 0) {
        hasCredentials = '有';
      }
    }

    rows.push({
      id: serverId,
      name,
      status,
      mcpType,
      category,
      hasCredentials
    });
  }

  // Sort by priority: Custom > Active > Disabled > Missing > Unknown
  const statusPriority = { Custom: 1, Active: 2, Disabled: 3, Missing: 4, Unknown: 5 };
  rows.sort((a, b) => {
    const diff = statusPriority[a.status] - statusPriority[b.status];
    if (diff !== 0) return diff;
    return a.name.localeCompare(b.name);
  });

  return { rows };
}

// __CONTINUE_HERE__
