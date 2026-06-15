#!/usr/bin/env zsh
# ClaudeConfig.zsh - macOS Claude Code 常用配置步骤
# 功能: 按 contracts ClaudeConfig 契约补齐受管配置并保护用户自定义字段

if [ -n "${CCQ_STEP_CLAUDECONFIG_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_STEP_CLAUDECONFIG_ZSH_LOADED=1

: "${CCQ_CLAUDE_CONFIG_CONTRACT:=${CCQ_CONTRACTS_DIR:-${CCQ_INSTALLER_ROOT}/contracts}/claude-config.json}"

ccq_claude_settings_path() { printf '%s\n' "${HOME}/.claude/settings.json"; }

ccq_claude_config_drift_script_path() {
  printf '%s\n' "${CCQ_CONTRACTS_DIR:-${CCQ_INSTALLER_ROOT}/contracts}/scripts/claude-config-drift.js"
}

ccq_claude_config_contract_ready() {
  command -v node >/dev/null 2>&1 || return 1
  [ -f "${CCQ_CLAUDE_CONFIG_CONTRACT}" ] || return 1
}

ccq_claude_config_result() {
  printf 'IsInstalled=%s\n' "${1:-false}"
  printf 'Version=\n'
  printf 'Message=%s\n' "${2:-}"
}

ccq_claude_config_install_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'ErrorMessage=%s\n' "${2:-}"
  if [ -n "${3:-}" ]; then
    printf 'UpdatedItems=%s\n' "${3}"
  fi
}

ccq_claude_config_analyze_json() {
  local settings_path script_path
  settings_path="$(ccq_claude_settings_path)"
  script_path="$(ccq_claude_config_drift_script_path)"

  ccq_claude_config_contract_ready || return 1
  [ -f "${script_path}" ] || return 1

  node "${script_path}" --contract-path "${CCQ_CLAUDE_CONFIG_CONTRACT}" --settings-path "${settings_path}" --mode analyze
}

ccq_claude_config_compare_drift() {
  ccq_claude_config_analyze_json
}

ccq_claude_config_apply() {
  local mode="${1:-install}"
  local settings_path script_path result_json new_settings updated_items
  settings_path="$(ccq_claude_settings_path)"
  script_path="$(ccq_claude_config_drift_script_path)"

  ccq_claude_config_contract_ready || return 1
  [ -f "${script_path}" ] || return 1

  result_json="$(node "${script_path}" --contract-path "${CCQ_CLAUDE_CONFIG_CONTRACT}" --settings-path "${settings_path}" --mode "${mode}" 2>/dev/null)" || return 1

  # 提取 newSettings 并写入
  new_settings="$(printf '%s' "${result_json}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(JSON.stringify(v.applied.newSettings, null, 2));' 2>/dev/null)" || return 1
  ccq_json_write_atomic "${settings_path}" "${new_settings}" || return 1

  # 提取 updatedItems
  updated_items="$(printf '%s' "${result_json}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write((v.applied.updatedItems || []).join(";"));' 2>/dev/null)" || updated_items="noop::ClaudeConfig::no-change"
  CCQ_CLAUDE_CONFIG_UPDATED_ITEMS="${updated_items}"
}

Test-ClaudeConfigInstalled() {
  local analysis needs_install parse_error
  analysis="$(ccq_claude_config_analyze_json 2>/dev/null || true)"
  if [ -z "${analysis}" ]; then
    ccq_claude_config_result false "ClaudeConfig 契约或 Node.js 不可用"
    return 0
  fi
  parse_error="$(printf '%s' "${analysis}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.details.parseError || "");' 2>/dev/null || true)"
  if [ -n "${parse_error}" ]; then
    ccq_claude_config_result false "settings.json 无法解析"
    return 0
  fi
  needs_install="$(printf '%s' "${analysis}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.needsInstallCompletion ? "true" : "false");' 2>/dev/null || printf 'true')"
  if [ "${needs_install}" = "false" ]; then
    ccq_claude_config_result true "Claude Code 常用配置已安装"
  else
    ccq_claude_config_result false "Claude Code 常用配置未完整安装"
  fi
}

Install-ClaudeConfig() {
  if ! ccq_claude_config_apply install; then
    ccq_claude_config_install_result false "ClaudeConfig 写入失败" ""
    return 1
  fi

  # 注册 ccq 快捷函数到 ~/.zshrc
  local updated_items="${CCQ_CLAUDE_CONFIG_UPDATED_ITEMS:-noop::ClaudeConfig::no-change}"
  if ccq_register_ccq_shortcut 2>/dev/null; then
    if [ "${updated_items}" = "noop::ClaudeConfig::no-change" ]; then
      updated_items="profile::ccq-function::registered"
    else
      updated_items="${updated_items};profile::ccq-function::registered"
    fi
  fi

  ccq_claude_config_install_result true "" "${updated_items}"
}

Verify-ClaudeConfig() {
  local analysis needs_install
  analysis="$(ccq_claude_config_analyze_json 2>/dev/null || true)"
  needs_install="$(printf '%s' "${analysis}" | node -e 'const fs=require("fs"); const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.needsInstallCompletion ? "true" : "false");' 2>/dev/null || printf 'true')"
  if [ "${needs_install}" = "false" ]; then
    printf 'Success=true\n'
    printf 'ErrorMessage=\n'
    return 0
  fi
  printf 'Success=false\n'
  printf 'ErrorMessage=ClaudeConfig 验证失败\n'
  return 1
}

Update-ClaudeConfig() {
  if ! ccq_claude_config_apply update; then
    ccq_claude_config_install_result false "ClaudeConfig 更新失败" ""
    return 1
  fi
  ccq_claude_config_install_result true "" "${CCQ_CLAUDE_CONFIG_UPDATED_ITEMS:-noop::ClaudeConfig::no-change}"
}

# ─── CCQ 函数注册 ───────────────────────────────────────────────────────────

ccq_get_ccq_function_template() {
  # 读取 ccq 函数模板（优先从 contracts/templates，fallback 到内联）
  local template_path contracts_root
  contracts_root="${CCQ_CONTRACTS_DIR:-${CCQ_INSTALLER_ROOT}/contracts}"
  template_path="${contracts_root}/templates/profile/ccq-function.zsh.txt"

  if [ -f "${template_path}" ]; then
    cat "${template_path}" 2>/dev/null && return 0
  fi

  # Fallback 到内联模板
  cat <<'EOF'
ccq() {
    # Claude Code Quickstart - 统一安装与管理面板入口
    # 显示菜单供用户选择：
    # [1] 安装面板 - 首次安装或重新安装
    # [2] 管理面板 - Provider/Skills/Update/MCP 管理

    echo ""
    echo "\033[36m════════════════════════════════════════════\033[0m"
    echo "\033[1m Claude Code Quickstart\033[0m"
    echo "\033[36m════════════════════════════════════════════\033[0m"
    echo ""
    echo "\033[32m  [1] 安装面板  - 首次安装或重新安装\033[0m"
    echo "\033[33m  [2] 管理面板  - Provider/Skills/Update/MCP\033[0m"
    echo "\033[90m  [Q] 退出\033[0m"
    echo ""

    read "choice?请选择: "

    case "$choice" in
        1)
            echo ""
            echo "\033[32m正在启动安装面板...\033[0m"
            local install_url="https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.sh"
            if curl -fsSL "$install_url" | bash; then
                :
            else
                echo "\033[31m❌ 安装面板启动失败\033[0m" >&2
                echo "\033[33m请检查网络连接后重试，或手动运行：\033[0m" >&2
                echo "\033[90m  curl -fsSL $install_url | bash\033[0m" >&2
                return 1
            fi
            ;;
        2)
            echo ""
            echo "\033[33m正在启动管理面板...\033[0m"
            local manage_url="https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.sh"
            if curl -fsSL "$manage_url" | bash; then
                :
            else
                echo "\033[31m❌ 管理面板启动失败\033[0m" >&2
                echo "\033[33m请检查网络连接后重试，或手动运行：\033[0m" >&2
                echo "\033[90m  curl -fsSL $manage_url | bash\033[0m" >&2
                return 1
            fi
            ;;
        [qQ])
            echo ""
            echo "\033[90m再见！\033[0m"
            return 0
            ;;
        *)
            echo ""
            echo "\033[31m无效选择，请重新运行 ccq\033[0m" >&2
            return 1
            ;;
    esac
}
EOF
}

ccq_register_ccq_shortcut() {
  # 在 ~/.zshrc 中注册 ccq 函数（使用 HC-4 标记块）
  local zshrc_path ccq_function

  zshrc_path="${HOME}/.zshrc"
  ccq_function="$(ccq_get_ccq_function_template)" || return 1

  # 使用 Profile 工具的标记块写入函数
  if ccq_profile_add_managed_block "${zshrc_path}" "${ccq_function}"; then
    ccq_ui_success "✓ ccq 快捷函数已注册到 ~/.zshrc"
    ccq_ui_info "使用方法: 在新终端中运行 'ccq' 打开菜单"
    return 0
  else
    ccq_ui_warning "注册 ccq 函数失败"
    return 1
  fi
}
