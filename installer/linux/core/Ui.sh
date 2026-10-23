#!/usr/bin/env bash
# Ui.sh - Linux 终端 UI 组件（Bash 语义）
# 功能: 语义输出、/dev/tty 交互、编号单选菜单、步骤状态与安装摘要
# 说明: 交互全部经 /dev/tty（兼容 curl … | bash 时 stdin 已被脚本占用）。
#       CCQ_TTY_IN / CCQ_TTY_OUT 仅供测试替换为普通文件，默认都是 /dev/tty。

: "${CCQ_OUTPUT_MODE:=normal}"
: "${CCQ_TTY_IN:=/dev/tty}"
: "${CCQ_TTY_OUT:=/dev/tty}"
CCQ_TTY_FD_OPEN=0

if [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ] && [ -z "${NO_COLOR:-}" ]; then
  CCQ_ANSI_RESET=$'\033[0m'
  CCQ_ANSI_PRIMARY=$'\033[1;36m'
  CCQ_ANSI_SUCCESS=$'\033[32m'
  CCQ_ANSI_WARNING=$'\033[33m'
  CCQ_ANSI_DANGER=$'\033[31m'
  CCQ_ANSI_INFO=''
  CCQ_ANSI_DIM=$'\033[2m'
else
  CCQ_ANSI_RESET='' CCQ_ANSI_PRIMARY='' CCQ_ANSI_SUCCESS='' CCQ_ANSI_WARNING=''
  CCQ_ANSI_DANGER='' CCQ_ANSI_INFO='' CCQ_ANSI_DIM=''
fi

ccq_set_output_mode() {
  case "${1:-normal}" in
    developer) CCQ_OUTPUT_MODE=developer ;;
    *) CCQ_OUTPUT_MODE=normal ;;
  esac
}

ccq_output_is_developer() {
  [ "${CCQ_OUTPUT_MODE}" = "developer" ]
}

ccq_ui_color() {
  case "${1:-info}" in
    success) printf '%s' "${CCQ_ANSI_SUCCESS}" ;;
    primary) printf '%s' "${CCQ_ANSI_PRIMARY}" ;;
    warning) printf '%s' "${CCQ_ANSI_WARNING}" ;;
    danger) printf '%s' "${CCQ_ANSI_DANGER}" ;;
    dim) printf '%s' "${CCQ_ANSI_DIM}" ;;
    *) printf '%s' "${CCQ_ANSI_INFO}" ;;
  esac
}

ccq_ui_write() {
  local type="${1:-info}" message="${2:-}" level="${3:-essential}"
  if [ "${level}" != "essential" ] && ! ccq_output_is_developer; then
    return 0
  fi
  printf '%s%s%s\n' "$(ccq_ui_color "${type}")" "${message}" "${CCQ_ANSI_RESET}"
}

ccq_ui_success() { ccq_ui_write success "${1:-}" "${2:-essential}"; }
ccq_ui_primary() { ccq_ui_write primary "${1:-}" "${2:-essential}"; }
ccq_ui_warning() { ccq_ui_write warning "${1:-}" "${2:-essential}"; }
ccq_ui_danger() { ccq_ui_write danger "${1:-}" "${2:-essential}"; }
ccq_ui_info() { ccq_ui_write info "${1:-}" "${2:-essential}"; }
ccq_ui_dim() { ccq_ui_write dim "${1:-}" "${2:-essential}"; }

ccq_show_banner() {
  printf '\n'
  ccq_ui_primary "═══ ${1:-Claude Code Quickstart} ═══"
  printf '\n'
}

# ─── /dev/tty ────────────────────────────────────────────────────────────────

ccq_tty_available() {
  # 真正尝试打开：容器内 /dev/tty 节点存在但无控制终端时 open 会失败，[ -r ] 判断不可靠。
  { : <"${CCQ_TTY_IN}" && : >>"${CCQ_TTY_OUT}"; } 2>/dev/null
}

ccq_tty_open() {
  [ "${CCQ_TTY_FD_OPEN}" = "1" ] && return 0
  ccq_tty_available || return 1
  # fd 9 只打开一次：菜单在 $(...) 子 shell 中读取时共享同一读偏移。
  exec 9<"${CCQ_TTY_IN}" || return 1
  CCQ_TTY_FD_OPEN=1
}

ccq_tty_write() {
  local type="${1:-info}" message="${2:-}"
  printf '%s%s%s\n' "$(ccq_ui_color "${type}")" "${message}" "${CCQ_ANSI_RESET}" >>"${CCQ_TTY_OUT}"
}

ccq_require_tty() {
  # 所有系统修改之前调用；无 TTY 时不得依赖隐含默认值继续。
  if ccq_tty_open; then
    return 0
  fi
  ccq_ui_danger "未检测到可交互终端（/dev/tty 不可读写），已安全退出，未做任何修改"
  ccq_ui_info "请在交互式终端中重新运行；--list-steps / --help 可在无终端环境使用"
  return 1
}

ccq_show_single_select_menu() {
  # 用法: ccq_show_single_select_menu <标题> <默认索引> <选项...>
  # 输出所选 0-based 索引；Enter 选默认项；q 或读取失败返回 1。
  local title="${1:-请选择}" default_index="${2:-0}"
  shift 2 || true
  local options=("$@") count="$#" choice i
  [ "${count}" -gt 0 ] || return 1
  case "${default_index}" in ''|*[!0-9]*) default_index=0 ;; esac
  [ "${default_index}" -lt "${count}" ] || default_index=$((count - 1))
  ccq_tty_open || return 1

  ccq_tty_write primary "${title}"
  for ((i = 0; i < count; i++)); do
    if [ "${i}" -eq "${default_index}" ]; then
      ccq_tty_write info "  $((i + 1)). ${options[i]}（默认）"
    else
      ccq_tty_write info "  $((i + 1)). ${options[i]}"
    fi
  done

  while true; do
    printf '请选择 (1-%s)，直接按 Enter 使用默认项，q 取消: ' "${count}" >>"${CCQ_TTY_OUT}"
    IFS= read -r choice <&9 || return 1
    choice="${choice//[[:space:]]/}"
    case "${choice}" in
      q|Q) return 1 ;;
      '') printf '%s\n' "${default_index}"; return 0 ;;
      *[!0-9]*) ;;
      *)
        if [ "${choice}" -ge 1 ] && [ "${choice}" -le "${count}" ]; then
          printf '%s\n' $((choice - 1))
          return 0
        fi
        ;;
    esac
    ccq_tty_write danger "无效选择，请输入 1 到 ${count} 之间的数字"
  done
}

# ─── 步骤状态与摘要 ──────────────────────────────────────────────────────────

ccq_result_field_from_text() {
  local result="${1:-}" field="${2:-}" line
  [ -n "${field}" ] || return 1
  while IFS= read -r line; do
    if [[ "${line}" == "${field}="* ]]; then
      printf '%s\n' "${line#"${field}="}"
      return 0
    fi
  done <<<"${result}"
  return 1
}

ccq_first_line() {
  local text="${1:-}"
  printf '%s\n' "${text%%$'\n'*}"
}

ccq_show_step_progress() {
  local step_name="${1:-}" step_status="${2:-Info}" message="${3:-}" detail
  detail="$(ccq_result_field_from_text "${message}" ErrorMessage 2>/dev/null || ccq_first_line "${message}")"
  case "${step_status}" in
    Success) ccq_ui_success "✅ ${step_name} 已安装" ;;
    Skipped) ccq_ui_warning "⏭ ${step_name} ${detail:-已跳过}" ;;
    Failed) ccq_ui_danger "❌ ${step_name} 安装失败${detail:+ - ${detail}}" ;;
    ManualRequired|Unsupported) ccq_ui_warning "⏭ ${step_name} 需手动处理${detail:+ - ${detail}}" ;;
    *) ccq_ui_info "  ${step_name} ${detail}" ;;
  esac
}

ccq_summary_status_text() {
  case "${1:-}" in
    Success) printf '成功' ;;
    Skipped) printf '跳过' ;;
    Failed) printf '失败' ;;
    ManualRequired|Unsupported) printf '需手动处理' ;;
    Pending) printf '未执行' ;;
    *) printf '未知' ;;
  esac
}

ccq_show_install_summary() {
  # 参数: 每行 "名称<TAB>状态<TAB>版本"
  local row name row_status version
  ccq_ui_primary "安装结果："
  for row in "$@"; do
    IFS=$'\t' read -r name row_status version <<<"${row}"
    case "${row_status}" in
      成功) ccq_ui_success "  ${name}: ${row_status} (${version:--})" ;;
      失败) ccq_ui_danger "  ${name}: ${row_status} (${version:--})" ;;
      *) ccq_ui_warning "  ${name}: ${row_status} (${version:--})" ;;
    esac
  done
}
