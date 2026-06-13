#!/usr/bin/env zsh
# McpManager.zsh - MCP Server 管理核心模块
# 功能: 承载 MCP 状态查看、禁用/启用/删除、批量切换、MCP Rules 渲染，供 Manage.zsh 复用
# 依赖: Ui.zsh, Json.zsh（须在本模块之前加载）

if [ -n "${CCQ_MCP_MANAGER_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_MCP_MANAGER_ZSH_LOADED=1

: "${CCQ_MCP_CONTRACT:=${CCQ_CONTRACTS_DIR:-${CCQ_INSTALLER_ROOT}/contracts}/mcp-servers.json}"
: "${CCQ_MCP_LOCK_FILE:=${TMPDIR:-/tmp}/.ccq-mcp-vault.lock}"
: "${CCQ_MCP_LOCK_TIMEOUT:=30}"

# ─── 路径助手 ───────────────────────────────────────────────────────────────

ccq_mcp_claude_json_path() { printf '%s\n' "${HOME}/.claude.json"; }
ccq_mcp_meta_path() { printf '%s\n' "${HOME}/.ccq/mcp-meta.json"; }
ccq_mcp_rules_dir() { printf '%s\n' "${HOME}/.claude/rules"; }
ccq_mcp_settings_path() { printf '%s\n' "${HOME}/.claude/settings.json"; }

ccq_mcp_tty() { [ -r /dev/tty ] && [ -w /dev/tty ]; }

ccq_mcp_prompt_text() {
  local prompt="${1:-请输入}"
  local value=""
  ccq_mcp_tty || return 1
  printf '%s: ' "${prompt}" >/dev/tty
  IFS= read -r value </dev/tty || return 1
  printf '%s' "${value}"
}

# ─── Vault 并发保护 ─────────────────────────────────────────────────────────
# macOS 无 flock(1) 命令，优先 zsh 原生 zsystem flock；Linux 环境兜底 flock(1)

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

# ─── Vault 腐败恢复 ─────────────────────────────────────────────────────────

ccq_mcp_vault_corrupt_backup() {
  local meta_path="${1:-}"
  local timestamp
  timestamp="$(date '+%Y%m%d_%H%M%S')"
  local backup_path="${meta_path}.corrupt.${timestamp}"
  cp "${meta_path}" "${backup_path}" 2>/dev/null || true

  # 清理超过 5 个的腐败备份
  local backup_dir
  backup_dir="$(dirname "${meta_path}")"
  local backups
  backups="$(find "${backup_dir}" -maxdepth 1 -name "$(basename "${meta_path}").corrupt.*" -type f 2>/dev/null | sort -r)" || backups=""
  local count=0
  for backup_file in ${(f)backups}; do
    count=$((count + 1))
    [ "${count}" -gt 5 ] && rm -f "${backup_file}"
  done
}

ccq_mcp_empty_vault_json() {
  printf '{"schemaVersion":1,"servers":{},"createdAt":"%s","updatedAt":"%s"}' \
    "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')"
}

ccq_mcp_vault_recover() {
  local meta_path
  meta_path="$(ccq_mcp_meta_path)"
  [ -f "${meta_path}" ] || return 0
  command -v node >/dev/null 2>&1 || return 0

  # JSON 解析失败 → 备份并重建空 Vault
  if ! node -e "JSON.parse(require('fs').readFileSync('${meta_path}', 'utf8'))" 2>/dev/null; then
    ccq_ui_warning "MCP Vault 文件损坏，已备份并重建"
    ccq_mcp_vault_corrupt_backup "${meta_path}"
    ccq_json_write_atomic "${meta_path}" "$(ccq_mcp_empty_vault_json)"
    return 0
  fi

  # schema 版本不为 1 → 备份并重建 v1 Vault
  local schema_version
  schema_version="$(node -e "const v=JSON.parse(require('fs').readFileSync('${meta_path}','utf8')); process.stdout.write(String(v.schemaVersion||0));" 2>/dev/null || printf '0')"
  if [ "${schema_version}" != "1" ]; then
    ccq_ui_warning "MCP Vault schema 版本不匹配，已备份并重建"
    ccq_mcp_vault_corrupt_backup "${meta_path}"
    ccq_json_write_atomic "${meta_path}" "$(ccq_mcp_empty_vault_json)"
  fi
}

# ─── 状态计算（ADR-06 优先级: Custom > Disabled > Active > Missing）─────────

# 输出 TSV: id <TAB> name <TAB> status <TAB> mcpType <TAB> category
ccq_mcp_status_lines() {
  local claude_json meta_path contract_path
  claude_json="$(ccq_mcp_claude_json_path)"
  meta_path="$(ccq_mcp_meta_path)"
  contract_path="${CCQ_MCP_CONTRACT}"
  command -v node >/dev/null 2>&1 || return 1
  node -e '
const fs = require("fs");
const [claudePath, metaPath, contractPath] = process.argv.slice(1);
const readJson = (p) => { try { const raw = fs.readFileSync(p, "utf8").trim(); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; } };
const claude = fs.existsSync(claudePath) ? readJson(claudePath) : {};
const meta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
const contract = fs.existsSync(contractPath) ? readJson(contractPath) : {};
const claudeServers = claude.mcpServers || {};
const metaServers = meta.servers || {};
const contractServers = contract.McpServers || {};
const ids = new Set([...Object.keys(claudeServers), ...Object.keys(metaServers), ...Object.keys(contractServers)]);
const rows = [];
for (const id of ids) {
  const inClaude = !!claudeServers[id];
  const inContract = !!contractServers[id];
  const disabled = !!(metaServers[id] && metaServers[id].disabled);
  let status;
  if (inClaude && !inContract) status = "Custom";
  else if (disabled) status = "Disabled";
  else if (inClaude && inContract) status = "Active";
  else if (inContract && !inClaude && !disabled) status = "Missing";
  else status = "Unknown";
  const def = contractServers[id] || {};
  rows.push([id, def.Name || id, status, def.McpType || "-", def.Category || "-"]);
}
const order = { Custom: 0, Active: 1, Disabled: 2, Missing: 3, Unknown: 4 };
rows.sort((a, b) => (order[a[2]] ?? 9) - (order[b[2]] ?? 9));
for (const row of rows) console.log(row.join("\t"));
' "${claude_json}" "${meta_path}" "${contract_path}"
}

ccq_mcp_status_label() {
  case "${1:-}" in
    Active) printf '已启用' ;;
    Disabled) printf '已禁用' ;;
    Missing) printf '未安装' ;;
    Custom) printf '自定义' ;;
    *) printf '未知' ;;
  esac
}

ccq_mcp_show_status() {
  local lines line id name mcp_status mcp_type category status_text
  lines="$(ccq_mcp_status_lines 2>/dev/null || true)"
  ccq_ui_primary "MCP Server 状态："
  if [ -z "${lines}" ]; then
    ccq_ui_warning "  尚未配置 MCP Server"
    return 0
  fi
  while IFS=$'\t' read -r id name mcp_status mcp_type category; do
    [ -n "${id}" ] || continue
    status_text="[$(ccq_mcp_status_label "${mcp_status}")]"
    case "${mcp_status}" in
      Active) ccq_ui_success "  ${status_text} ${name} (${id}) - ${mcp_type} - ${category}" ;;
      Disabled) ccq_ui_warning "  ${status_text} ${name} (${id}) - ${mcp_type} - ${category}" ;;
      Custom) ccq_ui_primary "  ${status_text} ${name} (${id})" ;;
      *) ccq_ui_dim "  ${status_text} ${name} (${id}) - ${mcp_type} - ${category}" ;;
    esac
  done <<EOF
${lines}
EOF
}

# ─── MCP Rules 动态渲染 ─────────────────────────────────────────────────────
# 根据已启用（Active）的 MCP Server 渲染 ~/.claude/rules/ccq-mcp-*.md
# 分类与文案来自契约 McpRulesCategories；某分类下无 Active Server 时删除文件

ccq_mcp_sync_rules() {
  local claude_json meta_path contract_path rules_dir
  claude_json="$(ccq_mcp_claude_json_path)"
  meta_path="$(ccq_mcp_meta_path)"
  contract_path="${CCQ_MCP_CONTRACT}"
  rules_dir="$(ccq_mcp_rules_dir)"
  command -v node >/dev/null 2>&1 || return 1
  [ -f "${contract_path}" ] || return 1
  mkdir -p "${rules_dir}"

  local changed
  changed="$(node -e '
const fs = require("fs");
const path = require("path");
const [claudePath, metaPath, contractPath, rulesDir] = process.argv.slice(1);
const readJson = (p) => { try { const raw = fs.readFileSync(p, "utf8").trim(); return raw ? JSON.parse(raw) : {}; } catch (e) { return {}; } };
const claude = fs.existsSync(claudePath) ? readJson(claudePath) : {};
const meta = fs.existsSync(metaPath) ? readJson(metaPath) : {};
const contract = readJson(contractPath);
const claudeServers = claude.mcpServers || {};
const metaServers = meta.servers || {};
const contractServers = contract.McpServers || {};
const categories = contract.McpRulesCategories || {};

// 计算 Active 状态：在 .claude.json 中、在契约定义中且未禁用
const activeIds = new Set();
for (const id of Object.keys(claudeServers)) {
  if (contractServers[id] && !(metaServers[id] && metaServers[id].disabled)) activeIds.add(id);
}

const changedFiles = [];
for (const [catName, cat] of Object.entries(categories)) {
  const filePath = path.join(rulesDir, cat.FileName);
  // 该分类下 Active 的 MCP IDs
  const enabledIds = new Set();
  for (const chain of cat.Chains || []) {
    for (const step of chain.Steps || []) {
      if (activeIds.has(step.McpId)) enabledIds.add(step.McpId);
    }
  }

  if (enabledIds.size === 0) {
    if (fs.existsSync(filePath)) {
      fs.unlinkSync(filePath);
      changedFiles.push(`${cat.FileName}::deleted`);
    }
    continue;
  }

  // 渲染 Markdown
  const lines = [];
  lines.push(`# ${cat.Title}`);
  lines.push("");
  lines.push("> 自动生成，请勿手动编辑。由 MCP Manager 根据已启用的 MCP Server 动态渲染。");
  lines.push("");
  if (cat.Desc) { lines.push(cat.Desc); lines.push(""); }
  lines.push("| 场景 | 工具链 |");
  lines.push("|------|--------|");
  for (const chain of cat.Chains || []) {
    const tools = [];
    for (const step of chain.Steps || []) {
      if (enabledIds.has(step.McpId)) tools.push(step.Tool);
    }
    if (chain.Fallback) tools.push(`${chain.Fallback}（兜底）`);
    if (tools.length > 0) lines.push(`| ${chain.Scenario} | \`${tools.join(" → ")}\` |`);
  }
  for (const row of cat.StaticRows || []) {
    lines.push(`| ${row.Scenario} | \`${row.Tool}\` |`);
  }
  lines.push("");
  if (cat.Tips && cat.Tips.length > 0) {
    lines.push("**Tips**:");
    for (const tip of cat.Tips) lines.push(`- ${tip}`);
    lines.push("");
  }
  const content = lines.join("\n");

  // 内容无变化则跳过写入
  let existing = "";
  if (fs.existsSync(filePath)) existing = fs.readFileSync(filePath, "utf8");
  if (existing.replace(/\r\n/g, "\n").trim() !== content.trim()) {
    const tmpPath = `${filePath}.tmp-${process.pid}`;
    fs.writeFileSync(tmpPath, content + "\n");
    fs.renameSync(tmpPath, filePath);
    changedFiles.push(`${cat.FileName}::updated`);
  }
}
process.stdout.write(changedFiles.join(";"));
' "${claude_json}" "${meta_path}" "${contract_path}" "${rules_dir}")" || {
    ccq_ui_warning "MCP Rules 同步失败" "developer"
    return 1
  }

  if [ -n "${changed}" ]; then
    ccq_ui_success "MCP Rules 已同步: ${changed}"
  fi
  return 0
}

# ─── 状态更新封装 ───────────────────────────────────────────────────────────

ccq_mcp_state_update_json() {
  local action="${1:-}"
  local server_id="${2:-}"
  local claude_path meta_path
  [ -n "${action}" ] && [ -n "${server_id}" ] || return 1
  claude_path="$(ccq_mcp_claude_json_path)"
  meta_path="$(ccq_mcp_meta_path)"
  ACTION="${action}" node -e '
const fs = require("fs");
const id = process.argv[1];
const claudePath = process.argv[2];
const metaPath = process.argv[3];
const action = process.env.ACTION;
let claude = fs.existsSync(claudePath) ? JSON.parse(fs.readFileSync(claudePath, "utf8") || "{}") : {};
let meta = fs.existsSync(metaPath) ? JSON.parse(fs.readFileSync(metaPath, "utf8") || "{}") : { schemaVersion: 1, servers: {} };
if (!meta.servers || typeof meta.servers !== "object") meta.servers = {};
if (action === "disable") {
  const config = claude.mcpServers?.[id] || meta.servers[id]?.config;
  if (!config) process.exit(1);
  if (!meta.servers[id]) meta.servers[id] = { credentials: { values: {}, envFileValues: {} } };
  meta.servers[id].config = config;
  meta.servers[id].disabled = true;
  meta.servers[id].updatedAt = new Date().toISOString();
  if (claude.mcpServers) delete claude.mcpServers[id];
} else if (action === "enable") {
  const entry = meta.servers[id];
  if (!entry || !entry.config) process.exit(1);
  if (!claude.mcpServers || typeof claude.mcpServers !== "object") claude.mcpServers = {};
  claude.mcpServers[id] = entry.config;
  entry.disabled = false;
  entry.updatedAt = new Date().toISOString();
} else if (action === "remove") {
  if (claude.mcpServers) delete claude.mcpServers[id];
  if (meta.servers) delete meta.servers[id];
} else {
  process.exit(1);
}
process.stdout.write(JSON.stringify({ claude, meta }, null, 2) + "\n");
' "${server_id}" "${claude_path}" "${meta_path}"
}

ccq_mcp_write_state_update() {
  local action="${1:-}"
  local server_id="${2:-}"
  local envelope claude_json meta_json
  envelope="$(ccq_mcp_state_update_json "${action}" "${server_id}")" || return 1
  claude_json="$(printf '%s' "${envelope}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(v.claude, null, 2) + "\n");')" || return 1
  meta_json="$(printf '%s' "${envelope}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(v.meta, null, 2) + "\n");')" || return 1
  ccq_json_write_atomic "$(ccq_mcp_claude_json_path)" "${claude_json}" || return 1
  ccq_json_write_atomic "$(ccq_mcp_meta_path)" "${meta_json}" || return 1
}

# ─── CRUD ───────────────────────────────────────────────────────────────────

ccq_mcp_do_state_update() {
  ccq_mcp_vault_recover
  ccq_mcp_write_state_update "$@" || return 1
  ccq_mcp_sync_rules >/dev/null 2>&1 || true
}

ccq_mcp_disable_server() {
  ccq_mcp_with_lock ccq_mcp_do_state_update disable "${1:-}"
}

ccq_mcp_enable_server() {
  ccq_mcp_with_lock ccq_mcp_do_state_update enable "${1:-}"
}

ccq_mcp_remove_server() {
  ccq_mcp_with_lock ccq_mcp_do_state_update remove "${1:-}"
}

# ─── 批量切换（Active 默认选中，Disabled 默认不选）──────────────────────────

ccq_mcp_toggle_menu() {
  local lines line id name mcp_status mcp_type category
  local ids=() statuses=() labels=() defaults=() idx=0
  lines="$(ccq_mcp_status_lines 2>/dev/null || true)"
  if [ -z "${lines}" ]; then
    ccq_ui_warning "尚未配置 MCP Server"
    return 0
  fi

  while IFS=$'\t' read -r id name mcp_status mcp_type category; do
    [ -n "${id}" ] || continue
    # 仅 Active / Disabled 参与批量切换；Custom/Missing 跳过
    case "${mcp_status}" in
      Active|Disabled) ;;
      *) continue ;;
    esac
    ids+=("${id}")
    statuses+=("${mcp_status}")
    labels+=("${name} (${id}) - $(ccq_mcp_status_label "${mcp_status}")")
    [ "${mcp_status}" = "Active" ] && defaults+=("${idx}")
    idx=$((idx + 1))
  done <<EOF
${lines}
EOF

  if [ "${#ids[@]}" -eq 0 ]; then
    ccq_ui_warning "没有可切换的 MCP Server（仅 Active/Disabled 可批量切换）"
    return 0
  fi

  ccq_mcp_tty || return 0
  local indices selected_set=" "
  indices="$(ccq_show_multi_select_menu "MCP 批量切换（选中=启用，取消=禁用）" "${defaults[*]}" "${labels[@]}")" || return 0
  local i
  for i in ${indices}; do
    selected_set="${selected_set}${i} "
  done

  local pos=0 target_id target_status changed=0
  for pos in $(seq 0 $(( ${#ids[@]} - 1 ))); do
    target_id="${ids[$((pos + 1))]}"
    target_status="${statuses[$((pos + 1))]}"
    case "${selected_set}" in
      *" ${pos} "*)
        # 选中 → 应为 Active
        if [ "${target_status}" = "Disabled" ]; then
          if ccq_mcp_enable_server "${target_id}"; then
            ccq_ui_success "已启用: ${target_id}"
            changed=$((changed + 1))
          else
            ccq_ui_warning "启用失败: ${target_id}"
          fi
        fi
        ;;
      *)
        # 未选中 → 应为 Disabled
        if [ "${target_status}" = "Active" ]; then
          if ccq_mcp_disable_server "${target_id}"; then
            ccq_ui_success "已禁用: ${target_id}"
            changed=$((changed + 1))
          else
            ccq_ui_warning "禁用失败: ${target_id}"
          fi
        fi
        ;;
    esac
  done
  [ "${changed}" -eq 0 ] && ccq_ui_dim "没有状态变更"
  return 0
}

# ─── 交互管理菜单 ───────────────────────────────────────────────────────────

ccq_mcp_manage_menu() {
  local choice server_id
  ccq_mcp_vault_recover
  ccq_mcp_sync_rules >/dev/null 2>&1 || true
  while true; do
    ccq_mcp_show_status
    [ -r /dev/tty ] || return 0
    choice="$(ccq_show_single_select_menu "MCP 管理 - 选择操作" 0 "批量切换" "启用单个" "禁用单个" "删除 Server" "返回")" || return 0
    case "${choice}" in
      0) ccq_mcp_toggle_menu ;;
      1) server_id="$(ccq_mcp_prompt_text "要启用的 ServerId")" && ccq_mcp_enable_server "${server_id}" || ccq_ui_warning "启用失败: ${CCQ_MCP_ERROR:-未知错误}" ;;
      2) server_id="$(ccq_mcp_prompt_text "要禁用的 ServerId")" && ccq_mcp_disable_server "${server_id}" || ccq_ui_warning "禁用失败: ${CCQ_MCP_ERROR:-未知错误}" ;;
      3) server_id="$(ccq_mcp_prompt_text "要删除的 ServerId")" && ccq_mcp_remove_server "${server_id}" || ccq_ui_warning "删除失败: ${CCQ_MCP_ERROR:-未知错误}" ;;
      4) return 0 ;;
      *) ccq_ui_warning "未知选项" ;;
    esac
  done
}
