#!/usr/bin/env zsh
# ManageCore.zsh - Manage JS 脚本集合部署（轻量 Node.js wrapper）
# 版本: 0.1.0（Phase 0 基础设施）
# 作者: 哈雷酱
# 功能: 部署 manage.js + provider/skills/update-manager.js 到 ~/.ccq/scripts/
#       （轻量 wrapper，与 McpManager.zsh 部署范式对称）
# 依赖: Ui.zsh（须在本模块之前加载）
#
# 说明：本模块在 Phase 0 仅提供部署能力，尚未接入 Manage.zsh 主入口。
#       待 Phase 1-3 完成 JS 业务逻辑迁移后，由 Manage.zsh 调用本模块切换到 JS 路径。

if [ -n "${CCQ_MANAGE_CORE_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_MANAGE_CORE_ZSH_LOADED=1

# ============================================================================
# 配置常量
# ============================================================================

# Manage JS 脚本版本（与 manage.js 的 SCRIPT_VERSION 保持一致）
CCQ_MANAGE_CORE_VERSION="1.0.0"

# 内嵌 base64 JSON（构建时注入，Release 模式使用）
# 格式: {"manage.js":"<base64>","provider-manager.js":"<base64>",...}
CCQ_MANAGE_SCRIPTS_JSON="${CCQ_MANAGE_SCRIPTS_JSON:-}"

# 需要部署的脚本清单（与 build.sh getManageScriptsBase64 保持一致）
CCQ_MANAGE_SCRIPT_NAMES=(
  "manage.js"
  "provider-manager.js"
  "skills-manager.js"
  "update-manager.js"
)

# ============================================================================
# 路径与部署
# ============================================================================

# 获取 Manage JS 脚本目录路径
ccq_manage_core_scripts_dir() {
  printf '%s\n' "${HOME}/.ccq/scripts"
}

# 部署 Manage JS 脚本集合到 ~/.ccq/scripts/
ccq_manage_core_ensure_scripts() {
  local scripts_dir manage_path existing_version
  scripts_dir="$(ccq_manage_core_scripts_dir)"

  # 确保目录存在
  mkdir -p "${scripts_dir}"

  # 检查是否需要部署（版本检测：manage.js 的 SCRIPT_VERSION）
  manage_path="${scripts_dir}/manage.js"
  if [ -f "${manage_path}" ]; then
    existing_version=$(grep -m1 "const SCRIPT_VERSION = " "${manage_path}" 2>/dev/null | sed "s/.*'\([^']*\)'.*/\1/")
    if [ "${existing_version}" = "${CCQ_MANAGE_CORE_VERSION}" ]; then
      # 版本一致，跳过部署
      return 0
    fi
  fi

  # 部署策略 1: 内嵌 base64 JSON（Release 模式）
  if [ -n "${CCQ_MANAGE_SCRIPTS_JSON}" ] && command -v node >/dev/null 2>&1; then
    # 用 node 解析 JSON 并逐个解码部署（跨平台一致）
    local deploy_result
    deploy_result=$(printf '%s' "${CCQ_MANAGE_SCRIPTS_JSON}" | node -e '
      const fs = require("fs");
      const path = require("path");
      let input = "";
      process.stdin.on("data", (d) => input += d);
      process.stdin.on("end", () => {
        try {
          const map = JSON.parse(input);
          const dir = process.argv[1];
          const names = process.argv.slice(2);
          let count = 0;
          for (const name of names) {
            if (map[name]) {
              fs.writeFileSync(path.join(dir, name), Buffer.from(map[name], "base64"));
              count++;
            }
          }
          process.stdout.write(String(count));
        } catch (e) {
          process.stderr.write(e.message);
          process.exit(1);
        }
      });
    ' "${scripts_dir}" "${CCQ_MANAGE_SCRIPT_NAMES[@]}" 2>/dev/null)

    if [ $? -eq 0 ] && [ "${deploy_result}" -gt 0 ] 2>/dev/null; then
      ccq_ui_success "Manage JS 脚本集合已部署（内嵌模式，${deploy_result} 个文件）"
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
    contracts_root="$(dirname "${CCQ_MACOS_ROOT}")/contracts"
  fi

  if [ -n "${contracts_root}" ] && [ -d "${contracts_root}/scripts" ]; then
    local source_script copied=0
    for name in "${CCQ_MANAGE_SCRIPT_NAMES[@]}"; do
      source_script="${contracts_root}/scripts/${name}"
      if [ -f "${source_script}" ]; then
        cp "${source_script}" "${scripts_dir}/${name}" 2>/dev/null && copied=$((copied + 1))
      fi
    done
    if [ "${copied}" -gt 0 ]; then
      ccq_ui_success "Manage JS 脚本集合已部署（源码模式，${copied} 个文件）"
      return 0
    fi
  fi

  # 部署失败
  ccq_ui_danger "无法部署 Manage JS 脚本集合（内嵌和源码模式均失败）"
  return 1
}

# ============================================================================
# 管理面板入口（对齐 Windows Show-ManagePanel）
# ============================================================================

ccq_manage_core_show_panel() {
  # 1. 检查 Node.js
  if ! command -v node >/dev/null 2>&1; then
    ccq_ui_danger "Node.js 未安装或不在 PATH 中"
    ccq_ui_info "请先安装 Node.js LTS：https://nodejs.org/"
    return 1
  fi

  # 2. 确保 JS 脚本存在且为最新版本
  ccq_manage_core_ensure_scripts || return 1

  # 3. 调用 manage.js（manage 模式，TTY 继承）
  local scripts_dir manage_path exit_code
  scripts_dir="$(ccq_manage_core_scripts_dir)"
  manage_path="${scripts_dir}/manage.js"

  node "${manage_path}"
  exit_code=$?

  if [ "${exit_code}" -ne 0 ]; then
    ccq_ui_warning "管理面板退出码: ${exit_code}"
  fi

  return "${exit_code}"
}
