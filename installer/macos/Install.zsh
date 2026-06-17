#!/usr/bin/env zsh
# Install.zsh - macOS 安装入口
# 功能: 前置检测、分组安装、执行计划确认和 ccq 快捷函数注册

if [ -z "${ZSH_VERSION:-}" ]; then
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && [ -x "/bin/zsh" ]; then
    exec /bin/zsh "${BASH_SOURCE[0]}" "$@"
  fi
  if [ -x "/bin/zsh" ]; then
    ccq_streamed_script="$(mktemp "${TMPDIR:-/tmp}/ccq-install.XXXXXX")" || exit 1
    cat > "${ccq_streamed_script}"
    export CCQ_STREAMED_SCRIPT_PATH="${ccq_streamed_script}"
    exec /bin/zsh "${ccq_streamed_script}" "$@"
  fi
  printf '%s\n' 'Install.zsh 需要 zsh 执行；云端 built 入口会自动切换到 /bin/zsh。' >&2
  exit 1
fi

if [ -n "${CCQ_STREAMED_SCRIPT_PATH:-}" ]; then
  trap 'rm -f "${CCQ_STREAMED_SCRIPT_PATH}"' EXIT
fi

setopt NO_NOMATCH
setopt PIPE_FAIL
setopt SH_WORD_SPLIT

# 避免继承上游 zsh xtrace，防止内部变量赋值污染安装输出。
set +x 2>/dev/null || true
unsetopt XTRACE 2>/dev/null || true
setopt NO_XTRACE 2>/dev/null || true

CCQ_MACOS_ROOT="$(cd "$(dirname "${0:A}")" && pwd)"
CCQ_INSTALLER_ROOT="$(cd "${CCQ_MACOS_ROOT}/.." && pwd)"
export CCQ_MACOS_ROOT CCQ_INSTALLER_ROOT

CCQ_PARAM_LIST_STEPS=0
CCQ_PARAM_GROUP=""
CCQ_PARAM_MODE=""
CCQ_PARAM_STAGED=0
CCQ_PARAM_OUTPUT_MODE="normal"
CCQ_SHORTCUT_REGISTERED=0

ccq_usage() {
  cat <<'EOF'
Usage: Install.zsh [OPTIONS]

Options:
  -ListSteps, --list-steps        列出已注册步骤后退出
  -Group, --group <Basic|Advanced> 指定安装分组
  -Mode, --mode <OneClick|Select>  指定 Advanced 安装模式
  -Staged, --staged              兼容参数，等同 Advanced Select
  -OutputMode, --output-mode <Normal|Developer>
  -h, --help                     显示帮助
EOF
}

ccq_parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -ListSteps|--list-steps)
        CCQ_PARAM_LIST_STEPS=1
        shift
        ;;
      -Group|--group)
        CCQ_PARAM_GROUP="${2:-}"
        shift 2
        ;;
      -Mode|--mode)
        CCQ_PARAM_MODE="${2:-}"
        shift 2
        ;;
      -Staged|--staged)
        CCQ_PARAM_STAGED=1
        shift
        ;;
      -OutputMode|--output-mode)
        CCQ_PARAM_OUTPUT_MODE="${2:-normal}"
        shift 2
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

  if [ "${CCQ_PARAM_STAGED}" = "1" ]; then
    CCQ_PARAM_GROUP="Advanced"
    CCQ_PARAM_MODE="Select"
  fi

  case "${CCQ_PARAM_OUTPUT_MODE:l}" in
    developer) CCQ_PARAM_OUTPUT_MODE="developer" ;;
    *) CCQ_PARAM_OUTPUT_MODE="normal" ;;
  esac
}

ccq_source_file() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || return 1
  source "${file_path}"
}

ccq_load_core() {
  if [ "${CCQ_BUILT_MODE:-0}" = "1" ] && command -v ccq_set_output_mode >/dev/null 2>&1; then
    ccq_set_output_mode "${CCQ_PARAM_OUTPUT_MODE}"
    return 0
  fi

  local core_dir="${CCQ_MACOS_ROOT}/core"
  local core_file
  for core_file in Ui Process Profile Platform PackageManager Json Registry Bootstrap Provider Update; do
    ccq_source_file "${core_dir}/${core_file}.zsh" || {
      printf '无法加载 macOS core: %s\n' "${core_file}.zsh" >&2
      return 1
    }
  done
  ccq_set_output_mode "${CCQ_PARAM_OUTPUT_MODE}"
}

ccq_load_step_modules() {
  if [ "${CCQ_BUILT_MODE:-0}" = "1" ]; then
    return 0
  fi

  local step_files step_file full_path
  step_files="$(ccq_get_step_files 2>/dev/null || true)"
  if [ -z "${step_files}" ]; then
    ccq_ui_warning "未能读取 macOS 步骤文件清单；仅可使用入口与管理骨架" "developer"
    return 0
  fi

  for step_file in ${step_files}; do
    full_path="${CCQ_INSTALLER_ROOT}/${step_file}"
    if [ -f "${full_path}" ]; then
      source "${full_path}"
    else
      ccq_ui_warning "步骤模块尚未实现，跳过加载: ${step_file}" "developer"
    fi
  done
}

ccq_confirm_homebrew_install() {
  if [ ! -r /dev/tty ]; then
    ccq_ui_warning "非交互环境无法确认安装 Homebrew，请手动安装后重试"
    return 1
  fi

  ccq_ui_info "将执行 Homebrew 官方安装命令："
  ccq_ui_dim "$(ccq_homebrew_install_command)"
  local choice
  choice="$(ccq_prompt_single "是否现在安装 Homebrew？" 0 "是，安装 Homebrew" "否，稍后手动安装")" || return 1
  [ "${choice}" = "0" ]
}

ccq_preflight() {
  if ! ccq_assert_macos_supported 12; then
    ccq_ui_danger "${CCQ_LAST_PLATFORM_ERROR:-macOS 版本检查失败}"
    return 1
  fi

  if ! ccq_is_zsh_shell; then
    ccq_ui_warning "当前登录 Shell 不是 zsh；如需切换请手动执行: chsh -s /bin/zsh"
  fi

  if ! command -v plutil >/dev/null 2>&1; then
    ccq_ui_danger "缺少 macOS plutil，无法进行 JSON 前置校验"
    return 1
  fi

  if ! ccq_brew_available; then
    ccq_ui_warning "Homebrew 未安装，macOS 自动化安装需要 Homebrew"
    if ! ccq_confirm_homebrew_install; then
      ccq_homebrew_install_hint
      return 1
    fi

    ccq_ui_primary "正在执行 Homebrew 官方安装脚本..."
    if ! ccq_install_homebrew; then
      ccq_ui_danger "Homebrew 安装失败，请按提示手动处理后重新运行 CCQ"
      ccq_homebrew_install_hint
      return 1
    fi

    if ! ccq_brew_available; then
      ccq_ui_danger "Homebrew 安装后仍不可用，请重新打开终端后重试"
      return 1
    fi

    ccq_apply_homebrew_post_install_steps "$(ccq_zprofile_path)" >/dev/null 2>&1 || \
      ccq_ui_warning "Homebrew 官方后续初始化失败；后续命令可能需要重新打开终端" "developer"
  fi

  ccq_refresh_path
}

ccq_bool_true() {
  case "${1:-}" in
    true|True|TRUE|1|yes|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

ccq_array_contains() {
  local needle="${1:-}"
  shift || true
  local item
  for item in "$@"; do
    [ "${item}" = "${needle}" ] && return 0
  done
  return 1
}

ccq_collect_dependencies() {
  local step_id="${1:-}"
  shift || true
  local seen=("$@")
  local dep deps

  if ccq_array_contains "${step_id}" "${seen[@]}"; then
    printf '%s\n' "${seen[@]}"
    return 0
  fi

  seen+=("${step_id}")
  deps="$(ccq_get_step_field "${step_id}" Dependencies 2>/dev/null || true)"
  for dep in ${deps}; do
    seen=( $(ccq_collect_dependencies "${dep}" "${seen[@]}") )
  done
  printf '%s\n' "${seen[@]}"
}

ccq_dependency_closure() {
  local selected=("$@")
  local all=()
  local step_id collected item
  for step_id in "${selected[@]}"; do
    collected="$(ccq_collect_dependencies "${step_id}" "${all[@]}")"
    all=( ${collected} )
  done
  ccq_get_execution_order "${all[@]}"
}

ccq_prompt_single() {
  local title="${1:-请选择}"
  local default_index="${2:-0}"
  shift 2 || true
  ccq_show_single_select_menu "${title}" "${default_index}" "$@"
}

ccq_prompt_multi() {
  local title="${1:-请选择}"
  local default_indices="${2:-}"
  shift 2 || true
  ccq_show_multi_select_menu "${title}" "${default_indices}" "$@"
}

ccq_silent_step_installed() {
  local test_function="${1:-}"
  local result
  [ -n "${test_function}" ] || return 1
  command -v "${test_function}" >/dev/null 2>&1 || return 1
  result="$(${test_function} 2>/dev/null || true)"
  ccq_result_is_installed "${result}"
}

ccq_show_step_list() {
  local group_name step_ids step_id step_name description optional deps tag group_label group_desc index=0
  ccq_ui_primary "已注册的安装步骤："
  printf '\n'
  for group_name in Basic Advanced; do
    step_ids="$(ccq_get_group_step_ids "${group_name}" 2>/dev/null || true)"
    [ -n "${step_ids}" ] || continue
    group_label="$(ccq_get_group_field "${group_name}" Label 2>/dev/null || printf '%s' "${group_name}")"
    group_desc="$(ccq_get_group_field "${group_name}" Description 2>/dev/null || true)"
    ccq_ui_primary "─── ${group_label}（${group_desc}）───"
    printf '\n'
    for step_id in ${step_ids}; do
      index=$((index + 1))
      step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
      description="$(ccq_get_step_field "${step_id}" Description 2>/dev/null || true)"
      optional="$(ccq_get_step_field "${step_id}" IsOptional 2>/dev/null || printf 'false')"
      deps="$(ccq_get_step_field "${step_id}" Dependencies 2>/dev/null | paste -sd ',' - || true)"
      tag="[必选]"
      ccq_bool_true "${optional}" && tag="[可选]"
      ccq_ui_info "  ${index}. ${tag} ${step_name}"
      ccq_ui_dim "       ${description}"
      ccq_ui_dim "       依赖: ${deps:-无}" "developer"
      printf '\n'
    done
  done
}

ccq_build_execution_plan() {
  local original=("$@")
  ccq_dependency_closure "${original[@]}"
}

ccq_confirm_execution_plan() {
  local original_count="${1:-0}"
  shift || true
  local original=()
  while [ "${original_count}" -gt 0 ] && [ "$#" -gt 0 ]; do
    original+=("$1")
    shift
    original_count=$((original_count - 1))
  done
  local final=("$@")
  local auto_added=() step_id idx=0 choice step_name

  for step_id in "${final[@]}"; do
    ccq_array_contains "${step_id}" "${original[@]}" || auto_added+=("${step_id}")
  done

  if [ "${#auto_added[@]}" -gt 0 ]; then
    ccq_ui_warning "以下依赖将自动纳入执行计划（已安装项会自动跳过）："
    for step_id in "${auto_added[@]}"; do
      step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
      ccq_ui_info "  + ${step_name}（自动补齐）"
    done
  fi

  ccq_ui_primary "执行计划："
  for step_id in "${final[@]}"; do
    idx=$((idx + 1))
    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    ccq_ui_info "  ${idx}. ${step_name}"
  done

  if [ ! -r /dev/tty ]; then
    ccq_ui_warning "非交互环境无法确认执行计划，已取消"
    return 1
  fi

  choice="$(ccq_prompt_single "确认执行以上计划？" 0 "是，开始执行" "否，取消")" || return 1
  [ "${choice}" = "0" ]
}

ccq_show_advanced_select_menu() {
  local step_ids step_id step_name description test_function optional installed tag options=() map=() defaults=() selected_indices selected_index
  step_ids="$(ccq_get_group_step_ids Advanced 2>/dev/null || true)"
  [ -n "${step_ids}" ] || return 1

  for step_id in ${step_ids}; do
    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    description="$(ccq_get_step_field "${step_id}" Description 2>/dev/null || true)"
    test_function="$(ccq_get_step_field "${step_id}" TestFunction 2>/dev/null || true)"
    optional="$(ccq_get_step_field "${step_id}" IsOptional 2>/dev/null || printf 'false')"
    if ccq_silent_step_installed "${test_function}"; then
      tag="【已安装】"
      installed=1
    else
      tag="【未安装】"
      installed=0
    fi
    options+=("${step_name}${tag} - ${description}")
    map+=("${step_id}")
    if [ "${installed}" = "0" ] && ! ccq_bool_true "${optional}"; then
      defaults+=("$(( ${#map[@]} - 1 ))")
    fi
  done

  selected_indices="$(ccq_prompt_multi "进阶扩展 - 选择要安装的组件：" "${defaults[*]}" "${options[@]}")" || return 1
  for selected_index in ${selected_indices}; do
    printf '%s\n' "${map[$((selected_index + 1))]}"
  done
}

ccq_register_ccq_shortcut() {
  [ "${CCQ_SHORTCUT_REGISTERED}" = "1" ] && return 0

  local install_url="https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/install.sh"
  local manage_url="https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.sh"
  local zshrc_path shortcut_content
  zshrc_path="$(ccq_zshrc_path)"

  shortcut_content="$(cat <<'CCQ_SHORTCUT'
function ccq() {
  local panel="${1:-}"
  local install_script_url="__INSTALL_SCRIPT_URL__"
  local manage_script_url="__MANAGE_SCRIPT_URL__"

  local run_remote_panel
  run_remote_panel() {
    local url="${1:-}"
    if ! command -v curl >/dev/null 2>&1; then
      printf '%s\n' 'curl 不可用，无法下载 CCQ 远程脚本' >&2
      return 1
    fi
    curl -fsSL "${url}" | bash
  }

  local show_ccq_panel_menu
  show_ccq_panel_menu() {
    local selected_index=1
    local options=('安装面板' '管理面板')
    local values=('Install' 'Manage')
    local count="${#options[@]}"
    local line_count=$((4 + count))
    local key next third i

    if [ ! -r /dev/tty ] || [ ! -w /dev/tty ] || [ "${TERM:-dumb}" = "dumb" ]; then
      printf '%s\n' "${values[$((selected_index + 1))]}"
      return 0
    fi

    local render_menu
    render_menu() {
      printf '\n%s\n' 'CCQ 面板选择' > /dev/tty
      printf '%s\n\n' '使用 ↑/↓ 选择，Enter 确认，Esc 取消' > /dev/tty
      i=1
      while [ "${i}" -le "${count}" ]; do
        if [ $((i - 1)) -eq "${selected_index}" ]; then
          printf '> %s\n' "${options[$i]}" > /dev/tty
        else
          printf '  %s\n' "${options[$i]}" > /dev/tty
        fi
        i=$((i + 1))
      done
    }

    local redraw_menu
    redraw_menu() {
      printf '\033[%sA\033[J' "${line_count}" > /dev/tty
      render_menu
    }

    local read_menu_key
    read_menu_key() {
      IFS= read -r -s -k 1 key < /dev/tty || return 1
      case "${key}" in
        $'\033')
          if IFS= read -r -s -k 1 -t 0.08 next < /dev/tty 2>/dev/null; then
            if [ "${next}" = "[" ]; then
              IFS= read -r -s -k 1 -t 0.08 third < /dev/tty 2>/dev/null || third=""
              case "${third}" in
                A) printf 'up\n' ;;
                B) printf 'down\n' ;;
                *) printf 'escape\n' ;;
              esac
            else
              printf 'escape\n'
            fi
          else
            printf 'escape\n'
          fi
          ;;
        $'\n'|$'\r') printf 'enter\n' ;;
        q|Q) printf 'escape\n' ;;
        *) printf 'other\n' ;;
      esac
    }

    printf '\033[?25l' > /dev/tty
    render_menu
    while true; do
      key="$(read_menu_key || printf 'escape')"
      case "${key}" in
        up)
          selected_index=$(((selected_index - 1 + count) % count))
          redraw_menu
          ;;
        down)
          selected_index=$(((selected_index + 1) % count))
          redraw_menu
          ;;
        enter)
          printf '\n\033[?25h' > /dev/tty
          printf '%s\n' "${values[$((selected_index + 1))]}"
          return 0
          ;;
        escape)
          printf '\n\033[?25h' > /dev/tty
          return 1
          ;;
      esac
    done
  }

  if [ -z "${panel}" ]; then
    panel="$(show_ccq_panel_menu)" || { printf '%s\n' '已取消'; return 0; }
  fi

  case "${panel}" in
    Install|安装面板) run_remote_panel "${install_script_url}" ;;
    Manage|管理面板) run_remote_panel "${manage_script_url}" ;;
    *) printf '未知面板: %s\n' "${panel}" >&2; return 1 ;;
  esac
}
CCQ_SHORTCUT
)"
  shortcut_content="${shortcut_content//__INSTALL_SCRIPT_URL__/${install_url}}"
  shortcut_content="${shortcut_content//__MANAGE_SCRIPT_URL__/${manage_url}}"

  if ccq_set_shortcut_subsection "${zshrc_path}" "${shortcut_content}" || \
     ccq_write_profile_subsection "${zshrc_path}" "SHORTCUTS" "${shortcut_content}"; then
    CCQ_SHORTCUT_REGISTERED=1
    eval "${shortcut_content}" 2>/dev/null || true
    ccq_ui_success "ccq 快捷函数已写入 ${zshrc_path}" "developer"
    return 0
  fi

  ccq_ui_warning "ccq 快捷函数持久化失败（不影响本次安装流程）" "developer"
  return 1
}

ccq_seed_fingerprints_after_install() {
  local executed=("$@")
  local fp_managed_steps=("ClaudeMd" "ClaudeConfig" "CcgWorkflow")
  local manifest step_id step_status fn_name fp seeded=0

  command -v ccq_profile_read_manifest >/dev/null 2>&1 || return 0
  manifest="$(ccq_profile_read_manifest 2>/dev/null || true)"
  [ -n "${manifest}" ] || manifest='{"schemaVersion":1,"steps":{}}'

  for step_id in "${executed[@]}"; do
    printf '%s\n' "${fp_managed_steps[@]}" | grep -qxF "${step_id}" || continue
    step_status="$(ccq_state_get_status "${step_id}" 2>/dev/null || true)"
    [ "${step_status}" = "Success" ] || [ "${step_status}" = "Skipped" ] || continue
    fn_name="Get-${step_id}Fingerprint"
    command -v "${fn_name}" >/dev/null 2>&1 || continue
    fp="$("${fn_name}" 2>/dev/null || true)"
    [ -n "${fp}" ] || continue
    manifest="$(printf '%s' "${manifest}" | STEP_ID="${step_id}" FP="${fp}" APPLIED_AT="$(date -u '+%Y-%m-%dT%H:%M:%SZ')" node -e '
const m = JSON.parse(require("fs").readFileSync(0, "utf8"));
if (!m.steps) m.steps = {};
m.steps[process.env.STEP_ID] = {
  fingerprint: process.env.FP,
  appliedAt: process.env.APPLIED_AT
};
console.log(JSON.stringify(m));
' 2>/dev/null)" || continue
    seeded=1
  done

  [ "${seeded}" = "1" ] && ccq_profile_write_manifest "${manifest}" 2>/dev/null || true
}

ccq_show_final_summary() {
  local executed=("$@")
  local success=0 skipped=0 failed=0 unsupported=0 manual=0 step_id step_status step_name version data status_text
  local rows=()

  printf '\n'
  for step_id in "${executed[@]}"; do
    step_status="$(ccq_state_get_status "${step_id}" 2>/dev/null || printf 'Skipped')"
    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    data="$(ccq_state_get_data "${step_id}" 2>/dev/null || true)"
    version="$(ccq_result_field_from_text "${data}" "Version" 2>/dev/null || true)"
    [ -n "${version}" ] || version='-'

    case "${step_status}" in
      Success) success=$((success + 1)) ;;
      Skipped) skipped=$((skipped + 1)) ;;
      Failed) failed=$((failed + 1)) ;;
      Unsupported) unsupported=$((unsupported + 1)) ;;
      ManualRequired) manual=$((manual + 1)) ;;
    esac

    status_text="$(ccq_summary_status_text "${step_status}")"
    rows+=("${step_name}	${status_text}	${version}")
  done

  if [ "${#rows[@]}" -gt 0 ]; then
    ccq_show_install_summary "${rows[@]}"
  fi

  printf '\n'
  ccq_ui_primary "安装统计："
  ccq_ui_success "  成功: ${success}"
  [ "${skipped}" -gt 0 ] && ccq_ui_warning "  跳过: ${skipped}"
  [ "${failed}" -gt 0 ] && ccq_ui_danger "  失败: ${failed}"
  if [ $((unsupported + manual)) -gt 0 ]; then
    ccq_ui_warning "  需手动处理: $((unsupported + manual))"
  fi

  # 指纹种子写入（Success/Skipped 步骤）
  ccq_seed_fingerprints_after_install "${executed[@]}"

  if [ "${failed}" -eq 0 ]; then
    ccq_register_ccq_shortcut >/dev/null 2>&1 || true
    printf '\n'
    ccq_ui_primary "快速开始：" "developer"
    ccq_ui_info "  ccq             - CCQ 面板入口（安装面板/管理面板）" "developer"
    ccq_ui_info "  claude          - 启动 Claude Code" "developer"
    ccq_ui_info "  claude --help   - 查看帮助信息" "developer"
  else
    printf '\n'
    ccq_ui_warning "安装完成，但有 ${failed} 个步骤失败"
    ccq_ui_info "重新运行安装器可重试失败步骤" "developer"
  fi

  printf '\n'
}

ccq_invoke_grouped_install() {
  local selected=("$@")
  local plan_text step_id
  local ordered=()
  [ "${#selected[@]}" -gt 0 ] || { ccq_ui_warning "未选择任何步骤"; return 0; }

  plan_text="$(ccq_build_execution_plan "${selected[@]}")" || { ccq_ui_warning "无法生成执行计划"; return 1; }
  ordered=( ${plan_text} )

  if [ "${#ordered[@]}" -eq 0 ]; then
    ccq_ui_success "所有选定步骤已安装，无需操作"
    ccq_register_ccq_shortcut >/dev/null 2>&1 || true
    return 0
  fi

  ccq_confirm_execution_plan "${#selected[@]}" "${selected[@]}" "${ordered[@]}" || { ccq_ui_warning "安装已取消"; return 0; }

  local total="${#ordered[@]}" step_index=0 step_name step_description
  for step_id in "${ordered[@]}"; do
    step_index=$((step_index + 1))
    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    step_description="$(ccq_get_step_field "${step_id}" Description 2>/dev/null || true)"
    printf '\n'
    ccq_ui_primary "步骤 ${step_index} / ${total}: ${step_name}"
    ccq_ui_info "🔄 执行步骤: ${step_name} (安装)"
    [ -n "${step_description}" ] && ccq_ui_dim "     ${step_description}" "developer"
    ccq_invoke_step_lifecycle "${step_id}" || true
  done

  ccq_show_final_summary "${ordered[@]}"
}

ccq_select_top_level_action() {
  ccq_prompt_single "请选择操作：" 0 \
    "基础环境 - Node.js, Git, Claude Code, 第三方供应商配置" \
    "进阶扩展 - 增强配置，MCP，Workflow"
}

ccq_select_advanced_action() {
  ccq_prompt_single "进阶扩展 - 请选择安装模式：" 0 \
    "一键安装 - 安装全部必选进阶组件（不含可选的 cc-switch/Codex/Antigravity CLI）" \
    "可选安装 - 选择要安装的组件"
}

ccq_advanced_required_step_ids() {
  local step_ids step_id optional
  step_ids="$(ccq_get_group_step_ids Advanced 2>/dev/null || true)"
  for step_id in ${step_ids}; do
    optional="$(ccq_get_step_field "${step_id}" IsOptional 2>/dev/null || printf 'false')"
    ccq_bool_true "${optional}" || printf '%s\n' "${step_id}"
  done
}

ccq_pause_for_main_menu() {
  local _ccq_pause_key
  [ -r /dev/tty ] || return 0
  printf '\n'
  ccq_ui_dim "按任意键返回主菜单..."
  IFS= read -r -s -k 1 _ccq_pause_key < /dev/tty || true
}

ccq_main() {
  ccq_parse_args "$@"
  ccq_load_core
  ccq_load_step_modules

  if [ "${CCQ_PARAM_LIST_STEPS}" = "1" ]; then
    ccq_show_step_list
    return 0
  fi

  ccq_show_banner "Claude Code Quickstart"
  ccq_ui_info "支持一键搭建 Claude Code 的开发环境及进阶功能" "developer"

  ccq_preflight || return 1

  if [ -n "${CCQ_PARAM_MODE}" ] && [ -z "${CCQ_PARAM_GROUP}" ]; then
    ccq_ui_danger "参数错误：-Mode 必须与 -Group 一起使用"
    return 2
  fi
  if [ "${CCQ_PARAM_GROUP}" = "Basic" ] && [ "${CCQ_PARAM_MODE}" = "Select" ]; then
    ccq_ui_danger "参数错误：基础环境仅支持一键安装"
    return 2
  fi

  if [ -n "${CCQ_PARAM_GROUP}" ]; then
    case "${CCQ_PARAM_GROUP}" in
      Basic)
        ccq_ui_primary "基础环境一键安装模式" "developer"
        ccq_invoke_grouped_install $(ccq_get_group_step_ids Basic)
        ;;
      Advanced)
        case "${CCQ_PARAM_MODE}" in
          Select)
            ccq_ui_primary "进阶扩展可选安装模式" "developer"
            ccq_invoke_grouped_install $(ccq_show_advanced_select_menu)
            ;;
          OneClick|oneclick|"")
            ccq_ui_primary "进阶扩展一键安装模式" "developer"
            ccq_invoke_grouped_install $(ccq_advanced_required_step_ids)
            ;;
          *)
            ccq_ui_danger "参数错误：-Mode 仅支持 OneClick 或 Select"
            return 2
            ;;
        esac
        ;;
      *)
        ccq_ui_danger "参数错误：-Group 仅支持 Basic 或 Advanced"
        return 2
        ;;
    esac
    return 0
  fi

  if [ ! -r /dev/tty ]; then
    ccq_ui_warning "非交互环境请使用 -Group Basic 或 -Group Advanced -Mode OneClick/Select"
    return 1
  fi

  local top_choice adv_choice selected_ids
  while true; do
    top_choice="$(ccq_select_top_level_action)" || { ccq_ui_primary "退出 CCQ" "developer"; break; }
    case "${top_choice}" in
      0)
        ccq_invoke_grouped_install $(ccq_get_group_step_ids Basic)
        ccq_pause_for_main_menu
        ;;
      1)
        adv_choice="$(ccq_select_advanced_action)" || continue
        case "${adv_choice}" in
          0)
            ccq_invoke_grouped_install $(ccq_advanced_required_step_ids)
            ccq_pause_for_main_menu
            ;;
          1)
            selected_ids="$(ccq_show_advanced_select_menu || true)"
            if [ -n "${selected_ids}" ]; then
              ccq_invoke_grouped_install ${selected_ids}
            else
              ccq_ui_warning "未选择任何步骤"
            fi
            ccq_pause_for_main_menu
            ;;
        esac
        ;;
    esac
  done
}

ccq_main "$@"
