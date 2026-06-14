#!/usr/bin/env zsh
# McpManager.zsh - MCP Server 管理核心模块（轻量 wrapper 架构）
# 功能: 调用共享 JS 脚本 mcp-manager.js 完成 MCP 管理（与 Windows 架构对齐）
# 依赖: Ui.zsh（须在本模块之前加载）

if [ -n "${CCQ_MCP_MANAGER_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_MCP_MANAGER_ZSH_LOADED=1

# ============================================================================
# 配置常量
# ============================================================================

# MCP Manager JS 脚本版本（与 mcp-manager.js 的 SCRIPT_VERSION 保持一致）
CCQ_MCP_MANAGER_SCRIPT_VERSION="1.0.0"

# 内嵌 base64（构建时注入，Release 模式使用）
CCQ_MCP_MANAGER_B64="${CCQ_MCP_MANAGER_B64:-}"

# ============================================================================
# 路径与部署
# ============================================================================

# 获取 MCP Manager JS 脚本路径
ccq_mcp_manager_script_path() {
  printf '%s\n' "${HOME}/.ccq/scripts/mcp-manager.js"
}

# 部署 MCP Manager JS 脚本到 ~/.ccq/scripts/
ccq_mcp_ensure_manager_script() {
  local script_path script_dir existing_version
  script_path="$(ccq_mcp_manager_script_path)"
  script_dir="${HOME}/.ccq/scripts"

  # 确保目录存在
  mkdir -p "${script_dir}"

  # 检查已有脚本版本
  if [ -f "${script_path}" ]; then
    existing_version=$(grep -m1 "const SCRIPT_VERSION = " "${script_path}" 2>/dev/null | sed "s/.*'\([^']*\)'.*/\1/")
    if [ "${existing_version}" = "${CCQ_MCP_MANAGER_SCRIPT_VERSION}" ]; then
      # 版本一致，跳过部署
      return 0
    fi
  fi

  # 部署策略 1: 内嵌 base64（Release 模式）
  if [ -n "${CCQ_MCP_MANAGER_B64}" ]; then
    if printf '%s' "${CCQ_MCP_MANAGER_B64}" | base64 -d > "${script_path}" 2>/dev/null; then
      ccq_ui_success "MCP Manager 脚本已部署（内嵌模式）"
      return 0
    else
      ccq_ui_warning "内嵌脚本部署失败"
    fi
  fi

  # 部署策略 2: 从源码目录复制（开发模式）
  local contracts_root
  if [ -n "${CCQ_INSTALLER_ROOT:-}" ]; then
    contracts_root="${CCQ_INSTALLER_ROOT}/contracts"
  elif [ -n "${CCQ_MACOS_ROOT:-}" ]; then
    # CCQ_MACOS_ROOT = installer/macos → installer/contracts
    contracts_root="$(dirname "${CCQ_MACOS_ROOT}")/contracts"
  fi

  if [ -n "${contracts_root}" ] && [ -d "${contracts_root}" ]; then
    local source_script="${contracts_root}/scripts/mcp-manager.js"
    if [ -f "${source_script}" ]; then
      cp "${source_script}" "${script_path}" || {
        ccq_ui_danger "源码脚本复制失败"
        return 1
      }

      # 同时复制契约文件到 ~/.ccq/mcp-servers.json（供 JS 脚本加载）
      local source_contract="${contracts_root}/mcp-servers.json"
      if [ -f "${source_contract}" ]; then
        local dest_contract="${HOME}/.ccq/mcp-servers.json"
        cp "${source_contract}" "${dest_contract}" 2>/dev/null || true
      fi

      ccq_ui_success "MCP Manager 脚本已部署（源码模式）"
      return 0
    fi
  fi

  # 部署失败
  ccq_ui_danger "无法部署 MCP Manager 脚本（内嵌和源码模式均失败）"
  return 1
}

# ============================================================================
# MCP 管理入口（对齐 Windows Show-McpManageMenu）
# ============================================================================

ccq_mcp_manage_menu() {
  # 1. 检查 Node.js
  if ! command -v node >/dev/null 2>&1; then
    ccq_ui_danger "Node.js 未安装或不在 PATH 中"
    ccq_ui_info "请先安装 Node.js LTS：https://nodejs.org/"
    return 1
  fi

  # 2. 确保 JS 脚本存在且为最新版本
  local script_path
  script_path="$(ccq_mcp_manager_script_path)"
  ccq_mcp_ensure_manager_script || return 1

  # 3. 调用 JS 脚本（manage 模式）
  # 关键：交互式 TUI 必须继承父进程的 TTY，直接调用 node 让其继承终端
  node "${script_path}" manage
  local exit_code=$?

  if [ "${exit_code}" -ne 0 ]; then
    ccq_ui_warning "MCP 管理退出码: ${exit_code}"
  fi

  return "${exit_code}"
}

# ============================================================================
# MCP Rules 同步（对齐 Windows Sync-AllMcpRules）
# ============================================================================

ccq_mcp_sync_rules() {
  local script_path
  script_path="$(ccq_mcp_manager_script_path)"
  ccq_mcp_ensure_manager_script || return 1

  node "${script_path}" sync-rules
}

# ============================================================================
# MCP 状态查看（对齐 Windows Get-McpStatus + Show-McpStatusTable）
# ============================================================================

ccq_mcp_show_status() {
  local script_path
  script_path="$(ccq_mcp_manager_script_path)"
  ccq_mcp_ensure_manager_script || return 1

  # 使用 --table 参数输出人类可读表格（而非 JSON）
  node "${script_path}" status --table
}

# ============================================================================
# 向后兼容函数（供其他模块使用）
# ============================================================================

# 旧版其他模块可能还在调用这些路径函数，保留以避免破坏
ccq_mcp_claude_json_path() { printf '%s\n' "${HOME}/.claude.json"; }
ccq_mcp_meta_path() { printf '%s\n' "${HOME}/.ccq/mcp-meta.json"; }
ccq_mcp_rules_dir() { printf '%s\n' "${HOME}/.claude/rules"; }
ccq_mcp_settings_path() { printf '%s\n' "${HOME}/.claude/settings.json"; }

# 旧版 vault 恢复函数（JS 脚本内部已实现，这里空壳保留兼容性）
ccq_mcp_vault_recover() { :; }
