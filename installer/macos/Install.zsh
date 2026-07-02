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
CCQ_PARAM_OUTPUT_MODE="normal"
CCQ_RELEASE_TAG="__CCQ_RELEASE_TAG__"

ccq_usage() {
  cat <<'EOF'
Usage: Install.zsh [OPTIONS]

Options:
  -ListSteps, --list-steps        列出已注册步骤后退出
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
  for core_file in Ui Process Profile Platform PackageManager Json Registry Bootstrap Update; do
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
    ccq_ui_info "将执行 Homebrew 官方安装命令："
    ccq_ui_dim "$(ccq_homebrew_install_command)"

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

# ─── 旧 Profile 标记块迁移清理 ─────────────────────────────────────────────────

ccq_cleanup_legacy_profile_blocks() {
  # 清理 ~/.zshrc 中历史遗留的 CCQ 标记块（旧 ccq 快捷函数注入残留）。
  # 旧 ClaudeConfig 步骤曾把 ccq() {...} 包在 HC-4 标记块里注入 ~/.zshrc（commit 429637c），
  # 迁移到 ccq 单文件可执行 + PATH 后注入逻辑已删，但用户机器残留未清。旧 ccq 函数会
  # curl 旧 install.sh，与新 ccq 可执行文件冲突，故在前置检测后清理。仅清标记块包裹内容，
  # 块外用户自定义不动；清理函数幂等，无块则 no-op。失败仅告警，不阻断主安装流程。
  local zshrc_path

  zshrc_path="$(ccq_zshrc_path)"
  [ -f "${zshrc_path}" ] || return 0

  # 探测是否存在标记块；无块则静默跳过
  if ! ccq_get_managed_block_content "${zshrc_path}" >/dev/null 2>&1; then
    return 0
  fi

  ccq_ui_dim "检测到旧 CCQ 标记块: ${zshrc_path}" "developer"
  if ccq_remove_managed_block_from_file "${zshrc_path}"; then
    ccq_ui_success "✓ 已清理旧 ccq 快捷函数残留: ${zshrc_path}"
  else
    ccq_ui_warning "清理旧 CCQ 标记块失败: ${zshrc_path}"
  fi

  return 0
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

ccq_show_step_list() {
  local group_name step_ids step_id step_name description optional deps tag group_label group_desc index=0
  ccq_ui_primary "已注册的安装步骤："
  printf '\n'
  for group_name in Basic; do
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

  if [ "${failed}" -eq 0 ]; then
    printf '\n'
    ccq_ui_primary "快速开始：" "developer"
    ccq_ui_info "  claude          - 启动 Claude Code" "developer"
    ccq_ui_info "  claude --help   - 查看帮助信息" "developer"
    printf '\n'
    ccq_ui_primary "管理面板（可选）：" "developer"
    ccq_ui_info "  ccq            - 启动 Claude Code Quickstart 管理控制台" "developer"
  else
    printf '\n'
    ccq_ui_warning "安装完成，但有 ${failed} 个步骤失败"
    ccq_ui_info "重新运行安装器可重试失败步骤" "developer"
  fi

  printf '\n'
}

ccq_invoke_grouped_install() {
  local skip_confirmation=0
  if [ "${1:-}" = "--skip-confirmation" ]; then
    skip_confirmation=1
    shift
  fi

  local selected=("$@")
  local plan_text step_id
  local ordered=()
  [ "${#selected[@]}" -gt 0 ] || { ccq_ui_warning "未选择任何步骤"; return 0; }

  plan_text="$(ccq_build_execution_plan "${selected[@]}")" || { ccq_ui_warning "无法生成执行计划"; return 1; }
  ordered=( ${plan_text} )

  if [ "${#ordered[@]}" -eq 0 ]; then
    ccq_ui_success "所有选定步骤已安装，无需操作"
    return 0
  fi

  if [ "${skip_confirmation}" != "1" ]; then
    ccq_confirm_execution_plan "${#selected[@]}" "${selected[@]}" "${ordered[@]}" || { ccq_ui_warning "安装已取消"; return 0; }
  fi

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


ccq_confirm_basic_install_plan() {
  ccq_ui_primary "本次将检查/安装以下基础环境组件："
  printf '\n'
  ccq_ui_info "  1. Homebrew（缺失时执行官方安装脚本）"
  ccq_ui_info "  2. nvm / Node.js（Basic 必需）"
  ccq_ui_info "  3. Git（Basic 必需）"
  ccq_ui_info "  4. Claude Code（Basic 必需）"
  printf '\n'

  local choice
  choice="$(ccq_prompt_single "确认开始安装基础环境？" 0 "是，开始安装" "否，取消")" || return 1
  [ "${choice}" = "0" ]
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
  ccq_ui_info "一键搭建 Claude Code 基础开发环境（Node.js / Git / Claude Code）" "developer"

  if ! ccq_confirm_basic_install_plan; then
    ccq_ui_info "安装已取消"
    return 0
  fi

  # 前置环境检测（macOS 12+ / Homebrew / nvm，zsh 单运行时）
  ccq_preflight || return 1

  # 旧 Profile 标记块迁移清理（幂等，无残留则 no-op）
  ccq_cleanup_legacy_profile_blocks

  # 基础环境直装（NodeJS / Git / ClaudeCode），无顶层菜单
  ccq_ui_primary "开始安装基础环境" "developer"
  ccq_invoke_grouped_install --skip-confirmation $(ccq_get_group_step_ids Basic)

  # ccq 可执行文件下载确认（TDR-6）
  printf '\n'
  ccq_confirm_executable_download
}

ccq_get_release_download_base_url() {
  # 解析 ccq 可执行文件下载基址；tag 构建使用当前 Release，源码运行回退 latest。
  if [ -n "${CCQ_RELEASE_DOWNLOAD_BASE_URL:-}" ]; then
    printf '%s' "${CCQ_RELEASE_DOWNLOAD_BASE_URL%/}"
    return 0
  fi

  # 哨兵判断以 v 开头（与 build 的 GITHUB_REF_NAME=v* 约定一致）。
  # 不能比对 __CCQ_RELEASE_TAG__ 字面量：build 用全局替换注入 tag，会把此处哨兵也
  # 换成实际 tag，导致 "v2.1.0-rc.x" != "v2.1.0-rc.x" 恒为假 → 永远走 latest 兜底。
  local tag="${CCQ_RELEASE_TAG:-}"
  case "${tag}" in
    v*)
      printf 'https://github.com/MrNine-666/claude-code-quickstart/releases/download/%s' "${tag}"
      return 0
      ;;
  esac

  printf 'https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download'
}

ccq_confirm_executable_download() {
  # 在 install 末尾弹出确认，询问用户是否下载 ccq 可执行文件到 ~/.local/bin
  # 遵守 TDR-6：用户拒绝则跳过；确认则按平台架构下载并设置可执行权限

  ccq_ui_primary "ccq 管理工具安装"
  printf '\n'
  ccq_ui_info "ccq 是 Claude Code Quickstart 的管理控制台，提供以下功能："
  ccq_ui_info "  • 供应商管理（Provider 配置）"
  ccq_ui_info "  • MCP Server 管理"
  ccq_ui_info "  • Skills 管理"
  ccq_ui_info "  • 提示词配置"
  ccq_ui_info "  • 配置文件管理"
  ccq_ui_info "  • 工具管理（ClaudeCode / Ccline / OpenSpec 等）"
  printf '\n'

  # 确认选择
  local decision
  decision="$(ccq_prompt_single "是否现在下载 ccq 可执行文件到 ~/.local/bin？（拒绝则跳过，可稍后手动安装）" 0 "是，下载 ccq" "否，稍后手动安装")" || decision=1
  if [ "${decision}" != "0" ]; then
    printf '\n'
    ccq_ui_info "已跳过 ccq 可执行文件下载"
    ccq_ui_dim "  如需稍后安装，请访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
    printf '\n'
    ccq_ui_primary "手动配置供应商（使用 Claude Code 必需）："
    ccq_ui_info "  在 ~/.claude/settings.json 中添加 API Key，示例："
    ccq_ui_dim '    { "env": { "ANTHROPIC_AUTH_TOKEN": "sk-ant-..." } }'
    ccq_ui_info "  或稍后安装 ccq 后通过「供应商」菜单可视化配置"
    return 0
  fi

  printf '\n'
  ccq_ui_info "正在准备下载 ccq 可执行文件..."

  # 1. 检测是否已安装
  local installed_json installed_status
  installed_json="$(ccq_test_executable_installed)"
  installed_status="$(printf '%s' "${installed_json}" | grep -o '"isInstalled":[^,}]*' | cut -d: -f2)"

  if [ "${installed_status}" = "1" ] || [ "${installed_status}" = "true" ]; then
    local installed_path installed_version
    installed_path="$(printf '%s' "${installed_json}" | grep -o '"path":"[^"]*"' | cut -d'"' -f4)"
    installed_version="$(printf '%s' "${installed_json}" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"

    ccq_ui_success "✓ ccq 可执行文件已安装: ${installed_path}"
    [ -n "${installed_version}" ] && ccq_ui_info "  当前版本: ${installed_version}"
    ccq_ui_dim "  如需更新，请在新终端运行: ccq"
    return 0
  fi

  # 2. 检测平台架构
  local arch
  arch="$(ccq_get_architecture)"
  ccq_ui_info "检测到平台架构: ${arch}"

  # 3. 构建下载 URL
  local base_url exe_name download_url
  base_url="$(ccq_get_release_download_base_url)"
  exe_name="ccq-${arch}"
  download_url="${base_url}/${exe_name}"

  ccq_ui_dim "  下载 URL: ${download_url}"

  # 4. 执行下载与安装
  if ccq_install_executable "${download_url}"; then
    printf '\n'
    ccq_ui_success " ccq 可执行文件安装成功！"
    printf '\n'
    ccq_ui_primary "下一步："
    ccq_ui_info "  1. 打开一个新的终端窗口"
    ccq_ui_info "  2. 输入 ccq 进入管理控制台"
    ccq_ui_info "  3. 选择「供应商」菜单配置 API Key，即可开始使用 Claude Code"
    printf '\n'
    ccq_ui_dim "（当前会话 PATH 尚未刷新，必须开启新终端 ccq 命令才生效）"
  else
    printf '\n'
    ccq_ui_warning "ccq 可执行文件下载失败"
    ccq_ui_info "您可以稍后手动下载："
    ccq_ui_info "  1. 访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
    ccq_ui_info "  2. 下载对应平台的可执行文件（${exe_name}）"
    ccq_ui_info "  3. 放置到 ~/.local/bin 并设置可执行权限（chmod +x）"
    printf '\n'
    ccq_ui_primary "手动配置供应商（使用 Claude Code 必需）："
    ccq_ui_info "  在 ~/.claude/settings.json 中添加 API Key，示例："
    ccq_ui_dim '    { "env": { "ANTHROPIC_AUTH_TOKEN": "sk-ant-..." } }'
    ccq_ui_info "  或等待 ccq 安装后通过「供应商」菜单可视化配置"
  fi
}

ccq_main "$@"
