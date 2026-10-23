#!/usr/bin/env bash
# Install.sh - Linux 安装入口
# 功能: 前置检测（发行版/权限/TTY）、Basic 步骤（Node.js / Git）与 ccq 下载 handoff
# 用法: bash installer/linux/Install.sh [--list-steps] [--output-mode <Normal|Developer>] [--help]

if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s\n' 'Install.sh 需要 bash 执行：bash installer/linux/Install.sh' >&2
  exit 1
fi

if [ -n "${CCQ_STREAMED_SCRIPT_PATH:-}" ]; then
  trap 'rm -f "${CCQ_STREAMED_SCRIPT_PATH}"' EXIT
fi

set +x 2>/dev/null || true
set -o pipefail

CCQ_LINUX_ROOT="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
CCQ_INSTALLER_ROOT="$(cd "${CCQ_LINUX_ROOT}/.." && pwd)"
export CCQ_LINUX_ROOT CCQ_INSTALLER_ROOT

CCQ_PARAM_LIST_STEPS=0
CCQ_PARAM_OUTPUT_MODE="normal"
: "${CCQ_RELEASE_TAG:=__CCQ_RELEASE_TAG__}"

ccq_usage() {
  cat <<'EOF'
Usage: Install.sh [OPTIONS]

Options:
  -ListSteps, --list-steps        列出已注册步骤后退出
  -OutputMode, --output-mode <Normal|Developer>
  -h, --help                     显示帮助

需在交互式终端中以普通用户运行；安装系统包时会单独调用 sudo。
EOF
}

ccq_parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -ListSteps|--list-steps)
        CCQ_PARAM_LIST_STEPS=1
        shift
        ;;
      -OutputMode|--output-mode)
        CCQ_PARAM_OUTPUT_MODE="${2:-normal}"
        shift 2 || shift
        ;;
      -h|--help)
        ccq_usage
        exit 0
        ;;
      *)
        printf '未知参数: %s\n' "$1" >&2
        ccq_usage >&2
        exit 2
        ;;
    esac
  done
  case "${CCQ_PARAM_OUTPUT_MODE,,}" in
    developer) CCQ_PARAM_OUTPUT_MODE="developer" ;;
    *) CCQ_PARAM_OUTPUT_MODE="normal" ;;
  esac
}

# core 加载顺序唯一声明在 core/Load.sh。
source "${CCQ_LINUX_ROOT}/core/Load.sh"

ccq_load_step_modules() {
  [ "${CCQ_BUILT_MODE:-0}" = "1" ] && return 0
  local step_file full_path
  for step_file in $(ccq_get_step_files); do
    full_path="${CCQ_INSTALLER_ROOT}/${step_file}"
    if [ ! -f "${full_path}" ]; then
      printf '无法加载 Linux 步骤模块: %s\n' "${step_file}" >&2
      return 1
    fi
    source "${full_path}"
  done
}

ccq_show_step_list() {
  local step_id index=0
  ccq_ui_primary "已注册的安装步骤："
  printf '\n'
  ccq_ui_primary "─── $(ccq_get_group_field Basic Label)（$(ccq_get_group_field Basic Description)）───"
  printf '\n'
  for step_id in $(ccq_get_group_step_ids Basic); do
    index=$((index + 1))
    ccq_ui_info "  ${index}. [必选] $(ccq_get_step_field "${step_id}" StepName)"
    ccq_ui_dim "       $(ccq_get_step_field "${step_id}" Description)"
    printf '\n'
  done
}

ccq_preflight() {
  # 只读检测全部通过后才要求 TTY；任何失败都发生在系统修改之前。
  if ! ccq_linux_require_runtime_user; then
    ccq_ui_danger "${CCQ_LAST_PLATFORM_ERROR}"
    return 1
  fi
  if ! ccq_linux_detect_distribution; then
    ccq_ui_danger "不支持的 Linux 环境: ${CCQ_LINUX_REASON}"
    ccq_ui_info "受支持基线: Ubuntu 24.04 / Debian 13 / Fedora 44 / CentOS Stream 10 / Arch Linux"
    ccq_ui_info "可手动安装 Node.js ${CCQ_REQUIRED_NODE_MAJOR:-20}+ 与 Git 后，用 download-tui.sh 只安装 ccq"
    return 1
  fi
  if ! ccq_linux_check_binary_runtime; then
    ccq_ui_danger "${CCQ_LAST_PLATFORM_ERROR}"
    return 1
  fi
  if ! ccq_command_exists curl && ! ccq_command_exists wget; then
    ccq_ui_danger "缺少 curl 或 wget，无法下载 nvm 与 ccq；请先通过发行版包管理器安装 curl"
    return 1
  fi
  ccq_command_exists gzip || ccq_ui_warning "未检测到 gzip，ccq 将直接下载未压缩资产"
  ccq_require_tty || return 1

  if [ "${CCQ_LINUX_CLASS}" = "official" ]; then
    ccq_ui_success "检测到 ${CCQ_OS_PRETTY_NAME:-${CCQ_OS_NAME}}（正式支持，包管理器: ${CCQ_LINUX_PM}）"
    return 0
  fi

  ccq_ui_warning "⚠ ${CCQ_OS_PRETTY_NAME:-${CCQ_OS_NAME:-${CCQ_OS_ID}}}：${CCQ_LINUX_REASON}"
  ccq_ui_warning "该环境未经验证，仅尽力兼容（包管理器: ${CCQ_LINUX_PM}），不承诺修复兼容问题"
  local choice
  choice="$(ccq_show_single_select_menu "是否在未经验证的环境中继续？" 1 "是，继续安装" "否，退出")" || choice=1
  [ "${choice}" = "0" ]
}

ccq_confirm_basic_install_plan() {
  ccq_ui_primary "本次将检查/安装以下基础环境组件："
  printf '\n'
  ccq_ui_info "  1. Node.js（已达标则复用；否则在现有 nvm/fnm 内安装，或用 nvm 官方脚本安装到用户目录）"
  ccq_ui_info "  2. Git（缺失时通过 ${CCQ_LINUX_PM} 安装，需要 sudo）"
  ccq_ui_info "  3. ccq 管理控制台（安装到 ~/.local/bin/ccq，末尾确认下载）"
  ccq_ui_dim "     Claude Code / Codex / Pi 将在 ccq「工具管理」中按需安装"
  printf '\n'

  local choice
  choice="$(ccq_show_single_select_menu "确认开始安装基础环境？" 0 "是，开始安装" "否，取消")" || return 1
  [ "${choice}" = "0" ]
}

ccq_run_basic_steps() {
  # 返回 0 = 全部 Success/Skipped；否则 1（ManualRequired/Unsupported/Failed 都不得伪装成功）。
  local ordered=() step_id index=0 rows=() step_status version not_ok=0
  read -r -a ordered <<<"$(ccq_get_execution_order $(ccq_get_group_step_ids Basic) | tr '\n' ' ')"

  for step_id in "${ordered[@]}"; do
    index=$((index + 1))
    printf '\n'
    ccq_ui_primary "步骤 ${index} / ${#ordered[@]}: $(ccq_get_step_field "${step_id}" StepName)"
    ccq_invoke_step_lifecycle "${step_id}" || true
  done

  printf '\n'
  for step_id in "${ordered[@]}"; do
    step_status="$(ccq_state_get_status "${step_id}" || printf 'Pending')"
    version="$(ccq_result_field_from_text "$(ccq_state_get_data "${step_id}")" Version || true)"
    rows+=("$(ccq_get_step_field "${step_id}" StepName)"$'\t'"$(ccq_summary_status_text "${step_status}")"$'\t'"${version:--}")
    case "${step_status}" in Success|Skipped) ;; *) not_ok=$((not_ok + 1)) ;; esac
  done
  ccq_show_install_summary "${rows[@]}"

  if [ "${not_ok}" -gt 0 ]; then
    ccq_ui_warning "有 ${not_ok} 个基础环境步骤未完成；请按上方提示处理后重新运行安装器"
    return 1
  fi
  return 0
}

ccq_main() {
  ccq_parse_args "$@"
  ccq_load_core || return 1
  ccq_load_step_modules || return 1

  if [ "${CCQ_PARAM_LIST_STEPS}" = "1" ]; then
    ccq_show_step_list
    return 0
  fi

  ccq_show_banner "Claude Code Quickstart"
  ccq_preflight || return 1

  if ! ccq_confirm_basic_install_plan; then
    ccq_ui_info "安装已取消"
    return 0
  fi

  local steps_status=0
  ccq_run_basic_steps || steps_status=1

  # 完整 install 沿用 macOS 语义：ccq 下载失败只告警；退出码反映基础环境是否完成。
  printf '\n'
  ccq_confirm_executable_download install || true
  return "${steps_status}"
}

ccq_main "$@"
