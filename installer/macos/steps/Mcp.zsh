#!/usr/bin/env zsh
# Mcp.zsh - macOS MCP Server 配置步骤
# 功能: 写入 .claude.json MCP 配置并复用 ~/.ccq/mcp-meta.json vault schema

if [ -n "${CCQ_STEP_MCP_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_STEP_MCP_ZSH_LOADED=1

: "${CCQ_MCP_CONTRACT:=${CCQ_CONTRACTS_DIR:-${CCQ_INSTALLER_ROOT}/contracts}/mcp-servers.json}"

ccq_mcp_claude_json_path() { printf '%s\n' "${HOME}/.claude.json"; }
ccq_mcp_settings_path() { printf '%s\n' "${HOME}/.claude/settings.json"; }
ccq_mcp_meta_path() { printf '%s\n' "${HOME}/.ccq/mcp-meta.json"; }

ccq_mcp_contract_ready() {
  command -v node >/dev/null 2>&1 || return 1
  [ -f "${CCQ_MCP_CONTRACT}" ] || return 1
}

ccq_mcp_result() {
  printf 'IsInstalled=%s\n' "${1:-false}"
  printf 'Version=\n'
  printf 'Message=%s\n' "${2:-}"
}

ccq_mcp_install_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'ConfiguredServers=%s\n' "${2:-0}"
  printf 'ErrorMessage=%s\n' "${3:-}"
}

ccq_mcp_tty() { [ -r /dev/tty ] && [ -w /dev/tty ]; }

ccq_mcp_prompt_text() {
  local prompt="${1:-请输入}"
  local value=""
  ccq_mcp_tty || return 1
  printf '%s: ' "${prompt}" >/dev/tty
  IFS= read -r value </dev/tty || return 1
  printf '%s' "${value}"
}

ccq_mcp_prompt_secret() {
  local prompt="${1:-凭据}"
  local value=""
  ccq_mcp_tty || return 1
  printf '%s: ' "${prompt}" >/dev/tty
  IFS= read -r -s value </dev/tty || return 1
  printf '\n' >/dev/tty
  printf '%s' "${value}"
}

ccq_mcp_recommended_ids() {
  ccq_mcp_contract_ready || return 1
  node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const servers = c.McpServers || {};
Object.entries(servers)
  .filter(([, server]) => server.Recommended)
  .sort((a, b) => (a[1].Priority || 9999) - (b[1].Priority || 9999))
  .forEach(([id]) => console.log(id));
' "${CCQ_MCP_CONTRACT}"
}

ccq_mcp_all_lines() {
  ccq_mcp_contract_ready || return 1
  node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const servers = c.McpServers || {};
Object.entries(servers)
  .sort((a, b) => (a[1].Priority || 9999) - (b[1].Priority || 9999))
  .forEach(([id, server]) => console.log([id, server.Name || id, server.Description || "", server.Recommended ? "recommended" : "optional"].join("\t")));
' "${CCQ_MCP_CONTRACT}"
}

ccq_mcp_select_servers() {
  local lines line id name desc tag options=() ids=() default_indices=() i
  lines="$(ccq_mcp_all_lines)" || return 1
  if ! ccq_mcp_tty; then
    ccq_mcp_recommended_ids
    return 0
  fi

  if ! command -v ccq_show_multi_select_menu >/dev/null 2>&1; then
    ccq_mcp_recommended_ids
    return 0
  fi

  i=0
  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    id="${line%%$'\t'*}"
    local rest="${line#*$'\t'}"
    name="${rest%%$'\t'*}"
    rest="${rest#*$'\t'}"
    desc="${rest%%$'\t'*}"
    tag="${rest#*$'\t'}"
    ids+=("${id}")
    options+=("${name} [$tag] - ${desc}")
    [ "${tag}" = "recommended" ] && default_indices+=("${i}")
    i=$((i + 1))
  done <<EOF
${lines}
EOF

  local selected_indices
  selected_indices="$(ccq_show_multi_select_menu "请选择要配置的 MCP Server（空格切换，Enter 确认）" "${default_indices[*]}" "${options[@]}")" || {
    ccq_mcp_recommended_ids
    return 0
  }

  for i in ${selected_indices}; do
    case "${i}" in
      ''|*[!0-9]*) ;;
      *) [ "${i}" -ge 0 ] && [ "${i}" -lt "${#ids[@]}" ] && printf '%s\n' "${ids[$(((i + 1) > ${#ids[@]} ? ${#ids[@]} : i + 1))]}" ;;
    esac
  done
}

# 读取 Vault 中已保存的历史凭据（用于安装时提示复用）
ccq_mcp_vault_credentials() {
  local server_id="${1:-}"
  local meta_path
  meta_path="$(ccq_mcp_meta_path)"
  [ -f "${meta_path}" ] || { printf '{}'; return 0; }
  command -v node >/dev/null 2>&1 || { printf '{}'; return 0; }
  node -e '
const fs = require("fs");
try {
  const data = JSON.parse(fs.readFileSync(process.argv[1], "utf8") || "{}");
  const entry = (data.servers || {})[process.argv[2]] || {};
  const creds = (entry.credentials || {}).values || {};
  process.stdout.write(JSON.stringify(creds));
} catch (e) { process.stdout.write("{}"); }
' "${meta_path}" "${server_id}" 2>/dev/null || printf '{}'
}

ccq_mcp_collect_credentials_json() {
  local server_id="${1:-}"
  ccq_mcp_contract_ready || return 1
  local fields field name label secret required value json="{}"
  local history_json history_value reply
  history_json="$(ccq_mcp_vault_credentials "${server_id}")"
  fields="$(node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const s = (c.McpServers || {})[process.argv[2]] || {};
const out = [];
if (s.CredentialType === "single-key" && s.ApiKeyName) out.push({name:s.ApiKeyName,label:s.ApiKeyName,secret:true,required:true});
for (const item of s.Credentials || []) out.push({name:item.Name,label:item.Label || item.Name,secret:!!item.Secret,required:item.Required !== false});
for (const item of s.ArgsCredentials || []) out.push({name:item.ArgName,label:item.Label || item.ArgName,secret:!!item.Secret,required:item.Required !== false});
if (s.TokenArg) out.push({name:s.TokenArg,label:s.TokenLabel || s.TokenArg,secret:true,required:true});
process.stdout.write(JSON.stringify(out));
' "${CCQ_MCP_CONTRACT}" "${server_id}")" || return 1

  while IFS= read -r field; do
    [ -n "${field}" ] || continue
    name="$(printf '%s' "${field}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.name || "");')"
    label="$(printf '%s' "${field}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.label || v.name || "");')"
    secret="$(printf '%s' "${field}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.secret ? "true" : "false");')"
    required="$(printf '%s' "${field}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.required ? "true" : "false");')"

    history_value="$(printf '%s' "${history_json}" | NAME="${name}" node -e 'const fs=require("fs"); const h=JSON.parse(fs.readFileSync(0,"utf8") || "{}"); process.stdout.write(h[process.env.NAME] || "");' 2>/dev/null || true)"

    if [ -n "${history_value}" ] && ccq_mcp_tty; then
      printf '  %s: 检测到历史凭据，复用? [Y/n] ' "${label}" >/dev/tty
      read -r reply </dev/tty
      if [ -z "${reply}" ] || [ "${reply}" = "Y" ] || [ "${reply}" = "y" ]; then
        value="${history_value}"
      else
        if [ "${secret}" = "true" ]; then
          value="$(ccq_mcp_prompt_secret "${label}（输入不会显示）")" || value=""
        else
          value="$(ccq_mcp_prompt_text "${label}")" || value=""
        fi
      fi
    elif [ "${secret}" = "true" ]; then
      value="$(ccq_mcp_prompt_secret "${label}（输入不会显示）")" || value=""
    else
      value="$(ccq_mcp_prompt_text "${label}")" || value=""
    fi
    if [ -z "${value}" ] && [ "${required}" = "true" ]; then
      CCQ_MCP_CREDENTIAL_ERROR="${label} 不能为空"
      return 1
    fi
    if [ -n "${value}" ]; then
      json="$(printf '%s' "${value}" | CRED_JSON="${json}" CRED_NAME="${name}" node -e '
const fs = require("fs");
const data = JSON.parse(process.env.CRED_JSON || "{}");
data[process.env.CRED_NAME] = fs.readFileSync(0, "utf8");
process.stdout.write(JSON.stringify(data));
')"
    fi
    value=""
  done <<EOF
$(printf '%s' "${fields}" | node -e 'const fs=require("fs"); const arr=JSON.parse(fs.readFileSync(0,"utf8") || "[]"); for (const item of arr) console.log(JSON.stringify(item));')
EOF
  printf '%s\n' "${json}"
}

ccq_mcp_build_server_entry_json() {
  local server_id="${1:-}"
  local credentials_json="${2}"
  [ -z "${credentials_json}" ] && credentials_json="{}"
  ccq_mcp_contract_ready || return 1
  CREDENTIALS_JSON="${credentials_json}" node -e '
const fs = require("fs");
const crypto = require("crypto");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const id = process.argv[2];
const server = (contract.McpServers || {})[id];
if (!server) process.exit(1);
const credentials = JSON.parse(process.env.CREDENTIALS_JSON || "{}");
function replacePlaceholders(text) {
  return String(text).replace(/\{([A-Za-z0-9_\-]+)\}/g, (_, key) => credentials[key] || "");
}
function buildConfig() {
  if (server.McpType === "http") {
    const url = server.UrlTemplate ? replacePlaceholders(server.UrlTemplate) : server.Url;
    return { type: "http", url };
  }
  const config = { command: server.Command, args: [...(server.Args || [])] };
  if (server.CredentialType === "single-key" && server.ApiKeyName && credentials[server.ApiKeyName]) {
    config.env = { [server.ApiKeyName]: credentials[server.ApiKeyName] };
  }
  if (server.CredentialType === "args-multi") {
    for (const item of server.ArgsCredentials || []) {
      if (credentials[item.ArgName]) config.args.push(item.ArgName, credentials[item.ArgName]);
    }
  }
  if (server.CredentialType === "args-token" && server.TokenArg && credentials[server.TokenArg]) {
    config.args.push(`${server.TokenArg}=${credentials[server.TokenArg]}`);
  }
  return config;
}
const config = buildConfig();
const definitionHash = crypto.createHash("sha256").update(JSON.stringify(server)).digest("hex").slice(0, 8);
// 紧凑单行输出：entry_json 经命令替换与 env 传递，多行 JSON 存在被截断/转义破坏的风险
process.stdout.write(JSON.stringify({ config, meta: { disabled: false, credentials: { values: credentials, envFileValues: {} }, config, definitionHash, updatedAt: new Date().toISOString() } }));
' "${CCQ_MCP_CONTRACT}" "${server_id}"
}

ccq_mcp_apply_server_json() {
  local server_id="${1:-}"
  local entry_json="${2:-}"
  local claude_json meta_path settings_path updated_claude updated_settings
  claude_json="$(ccq_mcp_claude_json_path)"
  meta_path="$(ccq_mcp_meta_path)"
  settings_path="$(ccq_mcp_settings_path)"

  updated_claude="$(ENTRY_JSON="${entry_json}" CLAUDE_JSON="${claude_json}" node -e '
const fs = require("fs");
const id = process.argv[1];
const entry = JSON.parse(process.env.ENTRY_JSON);
const target = process.env.CLAUDE_JSON;
let data = {};
if (fs.existsSync(target)) { const raw = fs.readFileSync(target, "utf8").trim(); if (raw) data = JSON.parse(raw); }
if (!data.mcpServers || typeof data.mcpServers !== "object") data.mcpServers = {};
data.mcpServers[id] = entry.config;
process.stdout.write(JSON.stringify(data, null, 2) + "\n");
' "${server_id}")" || return 1
  ccq_json_write_atomic "${claude_json}" "${updated_claude}" || return 1

  # vault 读-改-写需要并发锁保护（防止与 disable/enable/remove 并发冲突）
  if command -v ccq_mcp_with_lock >/dev/null 2>&1; then
    ccq_mcp_with_lock ccq_mcp_apply_meta_locked "${server_id}" "${entry_json}" "${meta_path}" || return 1
  else
    ccq_mcp_apply_meta_locked "${server_id}" "${entry_json}" "${meta_path}" || return 1
  fi

  updated_settings="$(SETTINGS_PATH="${settings_path}" node -e '
const fs = require("fs");
const id = process.argv[1];
const target = process.env.SETTINGS_PATH;
let data = {};
if (fs.existsSync(target)) { const raw = fs.readFileSync(target, "utf8").trim(); if (raw) data = JSON.parse(raw); }
if (!data.permissions || typeof data.permissions !== "object") data.permissions = {};
if (!Array.isArray(data.permissions.allow)) data.permissions.allow = [];
const perm = `mcp__${id}`;
if (!data.permissions.allow.includes(perm)) data.permissions.allow.push(perm);
process.stdout.write(JSON.stringify(data, null, 2) + "\n");
' "${server_id}")" || return 1
  ccq_json_write_atomic "${settings_path}" "${updated_settings}" || return 1
}

# vault 读-改-写（由 ccq_mcp_with_lock 包裹调用，防止与 disable/enable/remove 并发冲突）
ccq_mcp_apply_meta_locked() {
  local server_id="${1:-}"
  local entry_json="${2:-}"
  local meta_path="${3:-}"
  local updated_meta
  updated_meta="$(ENTRY_JSON="${entry_json}" META_PATH="${meta_path}" node -e '
const fs = require("fs");
const id = process.argv[1];
const entry = JSON.parse(process.env.ENTRY_JSON);
const target = process.env.META_PATH;
let data = { schemaVersion: 1, createdAt: new Date().toISOString(), servers: {} };
if (fs.existsSync(target)) { const raw = fs.readFileSync(target, "utf8").trim(); if (raw) data = JSON.parse(raw); }
if (!data.servers || typeof data.servers !== "object") data.servers = {};
data.schemaVersion = data.schemaVersion || 1;
data.updatedAt = new Date().toISOString();
data.servers[id] = entry.meta;
process.stdout.write(JSON.stringify(data, null, 2) + "\n");
' "${server_id}")" || return 1
  ccq_json_write_atomic "${meta_path}" "${updated_meta}"
}

ccq_mcp_install_server() {
  local server_id="${1:-}"
  local credentials_json entry_json
  credentials_json="$(ccq_mcp_collect_credentials_json "${server_id}")" || return 1
  entry_json="$(ccq_mcp_build_server_entry_json "${server_id}" "${credentials_json}")" || return 1
  ccq_mcp_apply_server_json "${server_id}" "${entry_json}"
}

ccq_mcp_configured_count() {
  local claude_json
  claude_json="$(ccq_mcp_claude_json_path)"
  [ -f "${claude_json}" ] || { printf '0'; return 0; }
  node -e 'const fs=require("fs"); const data=JSON.parse(fs.readFileSync(process.argv[1],"utf8") || "{}"); process.stdout.write(String(Object.keys(data.mcpServers || {}).length));' "${claude_json}" 2>/dev/null || printf '0'
}

Test-McpInstalled() {
  local count
  count="$(ccq_mcp_configured_count)"
  if [ "${count}" -gt 0 ]; then
    ccq_mcp_result true "已配置 ${count} 个 MCP Server"
  else
    ccq_mcp_result false "尚未配置 MCP Server"
  fi
}

Install-Mcp() {
  local ids server_id count=0
  ids="$(ccq_mcp_select_servers)" || {
    ccq_mcp_install_result false 0 "未选择 MCP Server"
    return 1
  }
  for server_id in ${ids}; do
    if ccq_mcp_install_server "${server_id}"; then
      count=$((count + 1))
    else
      ccq_ui_warning "MCP Server 配置失败或跳过: ${server_id}"
    fi
  done
  if [ "${count}" -eq 0 ]; then
    ccq_mcp_install_result false 0 "没有成功配置任何 MCP Server"
    return 1
  fi

  # 安装后同步 MCP Rules（core/McpManager.zsh 提供）
  if command -v ccq_mcp_sync_rules >/dev/null 2>&1; then
    ccq_mcp_sync_rules >/dev/null 2>&1 || ccq_ui_warning "MCP Rules 同步失败" "developer"
  fi

  ccq_mcp_install_result true "${count}" ""
}

Verify-Mcp() {
  local count
  count="$(ccq_mcp_configured_count)"
  if [ "${count}" -gt 0 ]; then
    printf 'Success=true\n'
    printf 'ErrorMessage=\n'
    return 0
  fi
  printf 'Success=false\n'
  printf 'ErrorMessage=MCP Server 配置验证失败\n'
  return 1
}

# ============================================================================
# Vault 并发保护（安装流程自给自足，不依赖 core/McpManager.zsh）
# macOS 无 flock(1) 命令，优先 zsh 原生 zsystem flock；Linux 环境兜底 flock(1)
# ============================================================================

: "${CCQ_MCP_LOCK_FILE:=${TMPDIR:-/tmp}/.ccq-mcp-vault.lock}"
: "${CCQ_MCP_LOCK_TIMEOUT:=30}"

ccq_mcp_with_lock() {
  local lock_file="${CCQ_MCP_LOCK_FILE}"
  local timeout="${CCQ_MCP_LOCK_TIMEOUT}"
  mkdir -p "$(dirname "${lock_file}")"

  if zmodload zsh/system 2>/dev/null && zsystem supports flock 2>/dev/null; then
    local lock_fd rc
    : >> "${lock_file}"
    if ! zsystem flock -t "${timeout}" -f lock_fd "${lock_file}" 2>/dev/null; then
      CCQ_MCP_ERROR="无法获取 MCP Vault 锁（${timeout}s 超时），可能有其他 CCQ 进程正在运行"
      return 1
    fi
    "$@"
    rc=$?
    zsystem flock -u "${lock_fd}" 2>/dev/null || true
    return ${rc}
  fi

  if command -v flock >/dev/null 2>&1; then
    local rc
    ( flock -x -w "${timeout}" 9 || exit 99; "$@" ) 9>"${lock_file}"
    rc=$?
    if [ "${rc}" -eq 99 ]; then
      CCQ_MCP_ERROR="无法获取 MCP Vault 锁（${timeout}s 超时），可能有其他 CCQ 进程正在运行"
      return 1
    fi
    return ${rc}
  fi

  # 无锁机制可用时直接执行（降级，不阻塞主流程）
  "$@"
}

# 管理函数已搬至 core/McpManager.zsh，此文件仅保留安装契约
