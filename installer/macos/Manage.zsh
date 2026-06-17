#!/usr/bin/env zsh
# Manage.zsh - macOS 管理入口
# 功能: Update、Provider、MCP、Skills 四类管理入口骨架

if [ -z "${ZSH_VERSION:-}" ]; then
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && [ -x "/bin/zsh" ]; then
    exec /bin/zsh "${BASH_SOURCE[0]}" "$@"
  fi
  if [ -x "/bin/zsh" ]; then
    ccq_streamed_script="$(mktemp "${TMPDIR:-/tmp}/ccq-manage.XXXXXX")" || exit 1
    cat > "${ccq_streamed_script}"
    export CCQ_STREAMED_SCRIPT_PATH="${ccq_streamed_script}"
    exec /bin/zsh "${ccq_streamed_script}" "$@"
  fi
  printf '%s\n' 'Manage.zsh 需要 zsh 执行；云端 built 入口会自动切换到 /bin/zsh。' >&2
  exit 1
fi

if [ -n "${CCQ_STREAMED_SCRIPT_PATH:-}" ]; then
  trap 'rm -f "${CCQ_STREAMED_SCRIPT_PATH}"' EXIT
fi

setopt NO_NOMATCH
setopt PIPE_FAIL
setopt SH_WORD_SPLIT

# 避免继承上游 zsh xtrace，防止内部变量赋值污染管理输出。
set +x 2>/dev/null || true
unsetopt XTRACE 2>/dev/null || true
setopt NO_XTRACE 2>/dev/null || true

CCQ_MACOS_ROOT="$(cd "$(dirname "${0:A}")" && pwd)"
CCQ_INSTALLER_ROOT="$(cd "${CCQ_MACOS_ROOT}/.." && pwd)"
export CCQ_MACOS_ROOT CCQ_INSTALLER_ROOT

CCQ_PARAM_ACTION=""
CCQ_PARAM_LIST_UPDATES=0
CCQ_PARAM_LIST_PROVIDERS=0
CCQ_PARAM_PROVIDER=""
CCQ_PARAM_OUTPUT_MODE="normal"

ccq_manage_usage() {
  cat <<'EOF'
Usage: Manage.zsh [OPTIONS]

Options:
  -Action, --action <Update|Provider|Mcp|Skills>  指定管理动作
  -ListUpdates, --list-updates                    列出可更新组件状态后退出
  -ListProviders, --list-providers                列出供应商状态后退出
  -Provider, --provider <key>                     切换活跃供应商
  -OutputMode, --output-mode <Normal|Developer>   输出模式
  -h, --help                                      显示帮助
EOF
}

ccq_manage_parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -Action|--action)
        CCQ_PARAM_ACTION="${2:-}"
        shift 2
        ;;
      -ListUpdates|--list-updates)
        CCQ_PARAM_LIST_UPDATES=1
        shift
        ;;
      -ListProviders|--list-providers)
        CCQ_PARAM_LIST_PROVIDERS=1
        shift
        ;;
      -Provider|--provider)
        CCQ_PARAM_PROVIDER="${2:-}"
        shift 2
        ;;
      -OutputMode|--output-mode)
        CCQ_PARAM_OUTPUT_MODE="${2:-normal}"
        shift 2
        ;;
      -h|--help)
        ccq_manage_usage
        exit 0
        ;;
      *)
        printf '未知参数: %s\n' "$1" >&2
        ccq_manage_usage >&2
        exit 2
        ;;
    esac
  done

  case "${CCQ_PARAM_OUTPUT_MODE:l}" in
    developer) CCQ_PARAM_OUTPUT_MODE="developer" ;;
    *) CCQ_PARAM_OUTPUT_MODE="normal" ;;
  esac
}

ccq_manage_source_file() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || return 1
  source "${file_path}"
}

ccq_manage_load_core() {
  if [ "${CCQ_BUILT_MODE:-0}" = "1" ] && command -v ccq_set_output_mode >/dev/null 2>&1; then
    ccq_set_output_mode "${CCQ_PARAM_OUTPUT_MODE}"
    return 0
  fi

  local core_dir="${CCQ_MACOS_ROOT}/core"
  local core_file
  for core_file in Ui Process Profile Platform PackageManager Json Registry Bootstrap Provider ManageCore Update; do
    ccq_manage_source_file "${core_dir}/${core_file}.zsh" || {
      printf '无法加载 macOS core: %s\n' "${core_file}.zsh" >&2
      return 1
    }
  done
  ccq_set_output_mode "${CCQ_PARAM_OUTPUT_MODE}"
}

ccq_manage_load_step_modules() {
  if [ "${CCQ_BUILT_MODE:-0}" = "1" ]; then
    return 0
  fi

  local step_files step_file full_path
  step_files="$(ccq_get_step_files 2>/dev/null || true)"
  for step_file in ${step_files}; do
    full_path="${CCQ_INSTALLER_ROOT}/${step_file}"
    if [ -f "${full_path}" ]; then
      source "${full_path}"
    else
      ccq_ui_warning "步骤模块尚未实现，跳过加载: ${step_file}" "developer"
    fi
  done
}

ccq_manage_prompt_single() {
  local title="${1:-请选择}"
  local default_index="${2:-0}"
  shift 2 || true
  ccq_show_single_select_menu "${title}" "${default_index}" "$@"
}

ccq_manage_prompt_multi() {
  local title="${1:-请选择}"
  local default_indices="${2:-}"
  shift 2 || true
  ccq_show_multi_select_menu "${title}" "${default_indices}" "$@"
}

ccq_manage_mask_status_value() {
  local value="${1:-}"
  if [ -z "${value}" ]; then
    printf '-'
  elif [ "${#value}" -le 8 ]; then
    printf '***'
  else
    printf '%s***%s' "${value:0:3}" "${value: -3}"
  fi
}

ccq_manage_result_field() {
  local result="${1:-}"
  local field="${2:-}"
  [ -n "${field}" ] || return 1
  ccq_parse_result_field "${result}" "${field}" 2>/dev/null || true
}

ccq_manage_step_test_result() {
  local test_function="${1:-}"
  [ -n "${test_function}" ] || return 1
  command -v "${test_function}" >/dev/null 2>&1 || return 1
  "${test_function}" 2>/dev/null || true
}

ccq_manage_step_installed() {
  local test_function="${1:-}"
  local result
  result="$(ccq_manage_step_test_result "${test_function}" 2>/dev/null || true)"
  [ -n "${result}" ] || return 1
  ccq_result_is_installed "${result}"
}

ccq_manage_update_hint() {
  case "${1:-}" in
    ClaudeCode|Ccline|OpenSpec|CodexCli) printf 'npm latest' ;;
    CcgWorkflow) printf 'npx refresh' ;;
    ClaudeConfig|ClaudeMd) printf '声明式对齐' ;;
    CcSwitch) printf 'brew cask' ;;
    AntigravityCli) printf 'agy update/install.sh' ;;
    *) printf 'update' ;;
  esac
}

# 步骤 → npm 全局包名映射（用于 hasUpdate 三态检测）
ccq_manage_npm_package_for_step() {
  case "${1:-}" in
    ClaudeCode) printf '@anthropic-ai/claude-code' ;;
    Ccline) printf '@cometix/ccline' ;;
    CodexCli) printf '@openai/codex' ;;
    OpenSpec) printf '@fission-ai/openspec' ;;
    *) printf '' ;;
  esac
}

# 计算单个步骤的 hasUpdate 三态: true / false / null
# 输出: hasUpdate <TAB> reason
ccq_manage_step_has_update() {
  local step_id="${1:-}"
  local npm_pkg components has_drift

  npm_pkg="$(ccq_manage_npm_package_for_step "${step_id}")"
  if [ -n "${npm_pkg}" ]; then
    if command -v ccq_npm_package_has_update >/dev/null 2>&1; then
      if [ "$(ccq_npm_package_has_update "${npm_pkg}")" = "true" ]; then
        printf 'true\tnpm 有新版本\n'
      else
        printf 'false\t已是最新\n'
      fi
      return 0
    fi
    printf 'null\t无法检测 npm 版本\n'
    return 0
  fi

  case "${step_id}" in
    CcgWorkflow)
      if command -v ccq_cg_update_components >/dev/null 2>&1; then
        components="$(ccq_cg_update_components 2>/dev/null || true)"
        local update_kind
        update_kind="$(ccq_parse_result_field "${components}" UpdateKind 2>/dev/null || printf 'none')"
        if [ "${update_kind}" = "none" ]; then
          printf 'false\t分量均为最新\n'
        else
          printf 'true\t%s\n' "${update_kind}"
        fi
        return 0
      fi
      printf 'null\t分量检测不可用\n'
      ;;
    ClaudeConfig)
      if command -v ccq_claude_config_analyze_json >/dev/null 2>&1; then
        has_drift="$(ccq_claude_config_analyze_json 2>/dev/null | node -e 'const fs=require("fs"); try { const v=JSON.parse(fs.readFileSync(0,"utf8")); process.stdout.write(v.hasUpdate ? "true" : "false"); } catch (e) { process.stdout.write("null"); }' 2>/dev/null || printf 'null')"
        case "${has_drift}" in
          true) printf 'true\t配置存在缺失或漂移\n' ;;
          false) printf 'false\t配置已对齐\n' ;;
          *) printf 'null\t无法解析配置\n' ;;
        esac
        return 0
      fi
      printf 'null\tdrift 检测不可用\n'
      ;;
    ClaudeMd)
      if command -v ccq_claudemd_has_update >/dev/null 2>&1; then
        if ccq_claudemd_has_update 2>/dev/null; then
          printf 'true\t模板内容有变更\n'
        else
          printf 'false\t模板内容一致\n'
        fi
        return 0
      fi
      printf 'null\t指纹检测不可用\n'
      ;;
    *)
      # CcSwitch / AntigravityCli 等无法程序判断 → null
      printf 'null\t无法检测，更新由工具自行判断\n'
      ;;
  esac
}

ccq_manage_update_status_lines() {
  local step_id update_function test_function step_name version_tag installed test_result hint settings_path
  local has_update_line has_update reason
  for step_id in $(ccq_get_group_step_ids Basic; ccq_get_group_step_ids Advanced); do
    update_function="$(ccq_get_step_field "${step_id}" UpdateFunction 2>/dev/null || true)"
    [ -n "${update_function}" ] || continue

    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    test_function="$(ccq_get_step_field "${step_id}" TestFunction 2>/dev/null || true)"
    installed="false"
    version_tag="-"
    test_result="$(ccq_manage_step_test_result "${test_function}" 2>/dev/null || true)"
    if [ -n "${test_result}" ]; then
      version_tag="$(ccq_manage_result_field "${test_result}" Version)"
      [ -n "${version_tag}" ] || version_tag="-"
      if ccq_result_is_installed "${test_result}"; then
        installed="true"
      fi
    fi

    if [ "${installed}" != "true" ] && [ "${step_id}" = "ClaudeConfig" ]; then
      settings_path="${HOME}/.claude/settings.json"
      if [ -f "${settings_path}" ]; then
        installed="true"
        version_tag="config"
      fi
    fi

    # hasUpdate 三态检测（仅对已安装步骤）
    has_update="null"
    reason="-"
    if [ "${installed}" = "true" ]; then
      has_update_line="$(ccq_manage_step_has_update "${step_id}")"
      if [ "${has_update_line}" != "${has_update_line#*$'\t'}" ]; then
        # 含 tab 分隔符：正常解析两段
        has_update="${has_update_line%%$'\t'*}"
        reason="${has_update_line#*$'\t'}"
      elif [ -n "${has_update_line}" ]; then
        # 无 tab（异常输出）：整行作为状态，reason 保持占位符
        has_update="${has_update_line}"
      fi
      case "${has_update}" in
        true|false|null) ;;
        *) has_update="null"; reason="检测输出异常" ;;
      esac
    fi

    hint="$(ccq_manage_update_hint "${step_id}")"
    printf '%s\t%s\t%s\t%s\t%s\t%s\t%s\t%s\n' "${step_id}" "${step_name}" "${installed}" "${version_tag}" "${update_function}" "${hint}" "${has_update}" "${reason}"
  done
}

ccq_manage_update_status() {
  local lines line step_id step_name installed version_tag update_function hint has_update reason state_text label
  ccq_ui_dim "正在检测组件状态与远程版本..."
  if command -v ccq_npm_outdated_global >/dev/null 2>&1; then
    ccq_npm_outdated_global true >/dev/null 2>&1 || true
  fi
  lines="$(ccq_manage_update_status_lines)"
  ccq_ui_primary "可更新组件状态："
  if [ -z "${lines}" ]; then
    ccq_ui_warning "  未发现注册了 UpdateFunction 的步骤"
    return 0
  fi

  while IFS=$'\t' read -r step_id step_name installed version_tag update_function hint has_update reason; do
    [ -n "${step_id}" ] || continue
    if [ "${installed}" != "true" ]; then
      label="$(ccq_status_label Skipped)"
      ccq_ui_info "  ${label} ${step_name} (${step_id}) - 未安装"
      continue
    fi
    case "${has_update}" in
      true)
        label="$(ccq_status_label Success)"
        state_text="有更新: ${reason}"
        ;;
      false)
        label="$(ccq_status_label Skipped)"
        state_text="已最新"
        ;;
      *)
        label="$(ccq_status_label Skipped)"
        state_text="未知: ${reason}"
        ;;
    esac
    ccq_ui_info "  ${label} ${step_name} (${step_id}) - ${state_text} - 当前版本: ${version_tag:-'-'} - 策略: ${hint}"
  done <<EOF
${lines}
EOF
}

ccq_manage_select_update_steps() {
  local lines line step_id step_name installed version_tag update_function hint has_update reason
  local ids=() labels=() defaults=() idx=0 indices selected_index update_count=0
  lines="$(ccq_manage_update_status_lines)"
  while IFS=$'\t' read -r step_id step_name installed version_tag update_function hint has_update reason; do
    [ -n "${step_id}" ] || continue
    [ "${installed}" = "true" ] || continue
    ids+=("${step_id}")
    case "${has_update}" in
      true)
        labels+=("${step_name} (${step_id}) - 有更新: ${reason}")
        defaults+=("${idx}")
        update_count=$((update_count + 1))
        ;;
      false)
        labels+=("${step_name} (${step_id}) - 已最新")
        ;;
      *)
        labels+=("${step_name} (${step_id}) - 未知: ${reason}")
        ;;
    esac
    idx=$((idx + 1))
  done <<EOF
${lines}
EOF

  if [ "${#ids[@]}" -eq 0 ]; then
    ccq_ui_warning "没有已安装的可更新步骤"
    return 1
  fi

  if [ "${update_count}" -eq 0 ]; then
    ccq_ui_success "所有可检测项目均为最新" >&2
  fi

  if [ ! -r /dev/tty ]; then
    # 非交互模式：仅执行确认有更新的项
    local pos=0
    for selected_index in "${defaults[@]}"; do
      printf '%s\n' "${ids[$(((selected_index + 1) > ${#ids[@]} ? ${#ids[@]} : selected_index + 1))]}"
    done
    return 0
  fi

  indices="$(ccq_manage_prompt_multi "可更新组件（默认选中有更新项）" "${defaults[*]}" "${labels[@]}")" || return 1
  for selected_index in ${indices}; do
    printf '%s\n' "${ids[$(((selected_index + 1) > ${#ids[@]} ? ${#ids[@]} : selected_index + 1))]}"
  done
}

ccq_manage_join_semicolon() {
  local first=1 item
  for item in "$@"; do
    if [ "${first}" = "1" ]; then
      printf '%s' "${item}"
      first=0
    else
      printf ';%s' "${item}"
    fi
  done
}

ccq_manage_safe_updated_items() {
  local step_id="${1:-Unknown}"
  local raw_items="${2:-}"
  local item lower sanitized=()
  raw_items="${raw_items//$'\n'/;}"
  if [ -z "${raw_items}" ]; then
    printf 'noop::%s::no-change' "${step_id}"
    return 0
  fi

  for item in ${(s:;:)raw_items}; do
    [ -n "${item}" ] || continue
    lower="${item:l}"
    case "${lower}" in
      *token*|*secret*|*password*|*credential*) sanitized+=("redacted::${step_id}::sensitive-value") ;;
      *"::"*"::"*) sanitized+=("${item}") ;;
      *) sanitized+=("invalid::${step_id}::malformed") ;;
    esac
  done

  if [ "${#sanitized[@]}" -eq 0 ]; then
    sanitized+=("noop::${step_id}::no-change")
  fi
  ccq_manage_join_semicolon "${sanitized[@]}"
}

ccq_manage_items_are_noop() {
  local raw_items="${1:-}"
  local item found=0
  raw_items="${raw_items//$'\n'/;}"
  for item in ${(s:;:)raw_items}; do
    [ -n "${item}" ] || continue
    found=1
    case "${item}" in
      noop::*) ;;
      *) return 1 ;;
    esac
  done
  [ "${found}" = "1" ]
}

ccq_manage_reset_update_summary() {
  CCQ_MANAGE_UPDATE_UPDATED=()
  CCQ_MANAGE_UPDATE_UPTODATE=()
  CCQ_MANAGE_UPDATE_FAILED=()
  CCQ_MANAGE_UPDATE_SKIPPED=()
}

ccq_manage_show_update_summary() {
  local item
  printf '\n'
  ccq_ui_primary "══════════════════════════════════════════"
  ccq_ui_primary "  更新结果摘要"
  ccq_ui_primary "══════════════════════════════════════════"

  printf '\n'
  if [ "${#CCQ_MANAGE_UPDATE_UPDATED[@]}" -gt 0 ]; then
    ccq_ui_success "  已更新 (${#CCQ_MANAGE_UPDATE_UPDATED[@]}):"
    for item in "${CCQ_MANAGE_UPDATE_UPDATED[@]}"; do
      ccq_ui_info "    ${item}"
    done
  else
    ccq_ui_success "  已更新 (0)"
  fi

  if [ "${#CCQ_MANAGE_UPDATE_UPTODATE[@]}" -gt 0 ]; then
    printf '\n'
    ccq_ui_dim "  已是最新 (${#CCQ_MANAGE_UPDATE_UPTODATE[@]}):"
    for item in "${CCQ_MANAGE_UPDATE_UPTODATE[@]}"; do
      ccq_ui_dim "    ${item}  (内容无变更)"
    done
  fi

  if [ "${#CCQ_MANAGE_UPDATE_FAILED[@]}" -gt 0 ]; then
    printf '\n'
    ccq_ui_danger "  失败 (${#CCQ_MANAGE_UPDATE_FAILED[@]}):"
    for item in "${CCQ_MANAGE_UPDATE_FAILED[@]}"; do
      ccq_ui_danger "    ${item}"
    done
  fi

  if [ "${#CCQ_MANAGE_UPDATE_SKIPPED[@]}" -gt 0 ]; then
    printf '\n'
    ccq_ui_warning "  已跳过 (${#CCQ_MANAGE_UPDATE_SKIPPED[@]}):"
    for item in "${CCQ_MANAGE_UPDATE_SKIPPED[@]}"; do
      ccq_ui_warning "    ${item}"
    done
  fi

  printf '\n'
  ccq_ui_primary "══════════════════════════════════════════"
}

ccq_manage_run_update_step() {
  local step_id="${1:-}"
  local update_function step_name result success updated_items version error_message result_status safe_items
  [ -n "${step_id}" ] || return 1
  update_function="$(ccq_get_step_field "${step_id}" UpdateFunction 2>/dev/null || true)"
  step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"

  if [ -z "${update_function}" ] || ! command -v "${update_function}" >/dev/null 2>&1; then
    CCQ_MANAGE_UPDATE_SKIPPED+=("${step_name} - 未注册更新函数")
    ccq_show_step_progress "${step_name}" "Skipped" "未注册更新函数"
    return 0
  fi

  ccq_ui_primary "─── 更新: ${step_name} ───"
  result="$(${update_function} 2>&1 || true)"
  success="$(ccq_manage_result_field "${result}" Success)"
  updated_items="$(ccq_manage_result_field "${result}" UpdatedItems)"
  version="$(ccq_manage_result_field "${result}" Version)"
  error_message="$(ccq_manage_result_field "${result}" ErrorMessage)"
  result_status="$(ccq_manage_result_field "${result}" Status)"
  safe_items="$(ccq_manage_safe_updated_items "${step_id}" "${updated_items}")"

  if ccq_normalize_success "${success}"; then
    if ccq_manage_items_are_noop "${safe_items}"; then
      CCQ_MANAGE_UPDATE_UPTODATE+=("${step_name} - ${safe_items}")
      ccq_show_step_progress "${step_name}" "Skipped" "内容无变更"
    else
      CCQ_MANAGE_UPDATE_UPDATED+=("${step_name} - ${safe_items}${version:+ - ${version}}")
      ccq_show_step_progress "${step_name}" "Success" "更新完成"
    fi
    return 0
  fi

  case "${result_status}" in
    ManualRequired|Unsupported)
      CCQ_MANAGE_UPDATE_SKIPPED+=("${step_name} - ${result_status}: ${error_message:-需要手动处理}")
      ccq_show_step_progress "${step_name}" "${result_status}" "${error_message:-需要手动处理}"
      return 0
      ;;
    *)
      CCQ_MANAGE_UPDATE_FAILED+=("${step_name} - ${error_message:-更新失败}")
      ccq_show_step_progress "${step_name}" "Failed" "${error_message:-更新失败}"
      return 1
      ;;
  esac
}

# Finalize: 成功更新的指纹管理步骤回写 manifest
ccq_manage_write_manifest_for_step() {
  local step_id="${1:-}"
  command -v ccq_update_write_manifest_entry >/dev/null 2>&1 || return 0
  case "${step_id}" in
    ClaudeMd)
      local fp entry
      if command -v ccq_file_fingerprint >/dev/null 2>&1; then
        fp="$(ccq_file_fingerprint "${HOME}/.claude/CLAUDE.md" 2>/dev/null || true)"
        [ -n "${fp}" ] || return 0
        entry="$(printf '{"fingerprint":"%s","appliedAt":"%s"}' "${fp}" "$(date -u '+%Y-%m-%dT%H:%M:%SZ')")"
        ccq_update_write_manifest_entry "${step_id}" "${entry}" 2>/dev/null || ccq_ui_warning "清单回写失败: ${step_id}" "developer"
      fi
      ;;
    CcgWorkflow)
      local engine_version entry
      engine_version="$(ccq_cg_version 2>/dev/null || true)"
      entry="$(printf '{"appliedAt":"%s","components":{"engineVersion":"%s"}}' "$(date -u '+%Y-%m-%dT%H:%M:%SZ')" "${engine_version}")"
      ccq_update_write_manifest_entry "${step_id}" "${entry}" 2>/dev/null || ccq_ui_warning "清单回写失败: ${step_id}" "developer"
      ;;
  esac
}

ccq_manage_update_action() {
  if [ "${CCQ_PARAM_LIST_UPDATES}" = "1" ]; then
    ccq_manage_update_status
    return 0
  fi

  # Init: 获取更新锁（防并发）
  if ! ccq_update_acquire_lock; then
    ccq_ui_danger "无法获取更新锁（30s 超时），可能有其他 CCQ 更新正在进行"
    return 1
  fi
  trap 'ccq_update_release_lock' EXIT INT TERM

  # Detect + Select: 状态检测与多选（默认选中有更新项）
  ccq_manage_update_status
  local selected_ids step_id fail_count=0
  selected_ids="$(ccq_manage_select_update_steps)" || { ccq_update_release_lock; trap - EXIT INT TERM; return 0; }
  if [ -z "${selected_ids}" ]; then
    ccq_ui_dim "未选择任何更新项"
    ccq_update_release_lock
    trap - EXIT INT TERM
    return 0
  fi

  # Snapshot: 创建更新前快照
  local snapshot_dir
  snapshot_dir="$(ccq_update_create_snapshot 2>/dev/null || echo "")"
  if [ -n "${snapshot_dir}" ]; then
    ccq_ui_dim "  快照目录: ${snapshot_dir}"
  else
    ccq_ui_warning "快照创建失败"
    if [ -r /dev/tty ]; then
      local reply
      printf '快照失败，是否继续更新? [y/N] ' >/dev/tty
      IFS= read -r reply </dev/tty || reply=""
      case "${reply}" in
        y|Y) ;;
        *) ccq_update_release_lock; trap - EXIT INT TERM; return 1 ;;
      esac
    else
      ccq_ui_danger "非交互模式下快照失败，中断更新"
      ccq_update_release_lock
      trap - EXIT INT TERM
      return 1
    fi
  fi

  # Execute: 按选择顺序执行更新
  ccq_manage_reset_update_summary
  for step_id in ${selected_ids}; do
    if ccq_manage_run_update_step "${step_id}"; then
      ccq_manage_write_manifest_for_step "${step_id}"
    else
      fail_count=$((fail_count + 1))
    fi
  done

  # Finalize: 摘要 + 清理旧快照 + 释放锁
  ccq_manage_show_update_summary
  ccq_update_clear_old_snapshots 5 7 "${snapshot_dir}"

  ccq_update_release_lock
  trap - EXIT INT TERM
  [ "${fail_count}" -eq 0 ]
}

ccq_manage_provider_dir() {
  printf '%s\n' "${HOME}/.claude/providers"
}

ccq_manage_settings_path() {
  printf '%s\n' "${HOME}/.claude/settings.json"
}

ccq_manage_show_provider_status() {
  local providers_dir settings_path file provider_name active_base_url active_token
  providers_dir="$(ccq_manage_provider_dir)"
  settings_path="$(ccq_manage_settings_path)"

  ccq_ui_primary "供应商状态："
  if [ -d "${providers_dir}" ]; then
    for file in "${providers_dir}"/*.json; do
      [ -f "${file}" ] || continue
      provider_name="$(basename "${file}" .json)"
      ccq_ui_info "  - ${provider_name} (${file})"
    done
  else
    ccq_ui_warning "  尚未发现 provider profile 目录"
  fi

  if [ -f "${settings_path}" ] && command -v node >/dev/null 2>&1; then
    active_base_url="$(node -e 'const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(j.env?.ANTHROPIC_BASE_URL || "");' "${settings_path}" 2>/dev/null || true)"
    active_token="$(node -e 'const fs=require("fs"); const p=process.argv[1]; const j=JSON.parse(fs.readFileSync(p,"utf8")); process.stdout.write(j.env?.ANTHROPIC_AUTH_TOKEN || "");' "${settings_path}" 2>/dev/null || true)"
    ccq_ui_info "  当前 Base URL: $(ccq_manage_mask_status_value "${active_base_url}")"
    ccq_ui_info "  当前 Token: $(ccq_manage_mask_status_value "${active_token}")"
  fi
}

ccq_manage_provider_action() {
  if command -v ccq_provider_show_status >/dev/null 2>&1; then
    if [ "${CCQ_PARAM_LIST_PROVIDERS}" = "1" ]; then
      ccq_provider_show_status
      return 0
    fi
    if [ -n "${CCQ_PARAM_PROVIDER}" ]; then
      ccq_provider_switch_key "${CCQ_PARAM_PROVIDER}" || { ccq_ui_danger "供应商切换失败: ${CCQ_PARAM_PROVIDER}"; return 1; }
      ccq_ui_success "已切换到供应商: ${CCQ_PARAM_PROVIDER}"
      return 0
    fi
    ccq_provider_manage_menu
    return $?
  fi

  ccq_manage_show_provider_status
  ccq_ui_warning "Provider 核心模块未加载"
}

ccq_manage_mcp_meta_path() {
  printf '%s\n' "${HOME}/.ccq/mcp-meta.json"
}

ccq_manage_mcp_action() {
  # MCP 管理统一路由到 JS 面板（manage.js 子菜单 [4] MCP → mcp-manager.js）
  if command -v ccq_manage_core_show_panel >/dev/null 2>&1; then
    ccq_manage_core_show_panel
    return $?
  fi

  local meta_path
  meta_path="$(ccq_manage_mcp_meta_path)"
  ccq_ui_primary "MCP 管理："
  if [ -f "${meta_path}" ]; then
    ccq_ui_info "  MCP vault: ${meta_path}"
  else
    ccq_ui_warning "  尚未发现 MCP vault: ${meta_path}"
  fi
  ccq_ui_warning "ManageCore 核心模块未加载"
}

ccq_manage_skills_action() {
  if command -v ccq_skills_manage_menu >/dev/null 2>&1; then
    ccq_skills_manage_menu
    return $?
  fi

  ccq_ui_primary "Skills 管理："
  if command -v skills >/dev/null 2>&1; then
    ccq_ui_info "  skills: $(command -v skills)"
  elif command -v npx >/dev/null 2>&1; then
    ccq_ui_info "  npx 可用，可执行官方 skills 命令"
  else
    ccq_ui_warning "  未检测到 skills 或 npx"
  fi
  ccq_ui_warning "Skills 步骤模块未加载，无法打开完整 Skills 管理菜单"
}

ccq_manage_select_action() {
  ccq_manage_prompt_single "CCQ 环境管理" 0 \
    "更新管理   - 检测并更新已安装组件" \
    "供应商管理  - 管理 AI 供应商配置" \
    "MCP 管理   - 管理 MCP Server 配置" \
    "Skills 管理 - 安装/更新/卸载 Skills"
}

ccq_manage_dispatch_action() {
  local action="${1:-}"
  case "${action}" in
    Update|update|更新管理) ccq_manage_update_action ;;
    Provider|provider|供应商管理) ccq_manage_provider_action ;;
    Mcp|MCP|mcp|MCP管理) ccq_manage_mcp_action ;;
    Skills|skills|Skills管理) ccq_manage_skills_action ;;
    *) ccq_ui_danger "未知管理动作: ${action}"; return 2 ;;
  esac
}

ccq_manage_pause_for_main_menu() {
  local _ccq_pause_key
  [ -r /dev/tty ] || return 0
  printf '\n'
  ccq_ui_dim "按任意键返回主菜单..."
  IFS= read -r -s -k 1 _ccq_pause_key < /dev/tty || true
}

ccq_manage_main() {
  ccq_manage_parse_args "$@"
  ccq_manage_load_core
  ccq_manage_load_step_modules

  ccq_show_banner "CCQ 环境管理"
  ccq_ui_info "管理已安装组件的更新、供应商、MCP 和 Skills 配置" "developer"

  if [ -n "${CCQ_PARAM_ACTION}" ]; then
    ccq_manage_dispatch_action "${CCQ_PARAM_ACTION}"
    return $?
  fi

  if [ ! -r /dev/tty ]; then
    ccq_ui_warning "非交互环境请使用 -Action Update/Provider/Mcp/Skills"
    return 1
  fi

  # JS 统一管理面板（manage.js 子菜单路由 Update/Provider/MCP/Skills）
  # CLI 模式（-Action）仍走上方 dispatch；manage.js 为纯交互面板（无 CLI 参数）
  ccq_manage_core_show_panel
}

ccq_manage_main "$@"
