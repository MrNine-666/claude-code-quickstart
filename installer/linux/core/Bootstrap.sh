#!/usr/bin/env bash
# Bootstrap.sh - Linux 步骤生命周期调度
# 功能: Test → Install → Verify 生命周期与 Pending/Running/Success/Failed/Skipped/Unsupported/ManualRequired 状态
# 说明: step 函数以 stdout 输出 key=value 结果（Success / Status / Version / ErrorMessage），
#       命令输出与交互分别走 stderr 与 /dev/tty。

CCQ_STATE_STEP_IDS=()
CCQ_STATE_STEP_STATUSES=()
CCQ_STATE_STEP_DATA=()

ccq_state_index_of() {
  local i
  for i in "${!CCQ_STATE_STEP_IDS[@]}"; do
    if [ "${CCQ_STATE_STEP_IDS[i]}" = "${1:-}" ]; then
      printf '%s' "${i}"
      return 0
    fi
  done
  return 1
}

ccq_state_set_step() {
  local step_id="$1" step_status="$2" data="${3:-}" idx
  if idx="$(ccq_state_index_of "${step_id}")"; then
    CCQ_STATE_STEP_STATUSES[idx]="${step_status}"
    CCQ_STATE_STEP_DATA[idx]="${data}"
  else
    CCQ_STATE_STEP_IDS+=("${step_id}")
    CCQ_STATE_STEP_STATUSES+=("${step_status}")
    CCQ_STATE_STEP_DATA+=("${data}")
  fi
}

ccq_state_get_status() {
  local idx
  idx="$(ccq_state_index_of "${1:-}")" || return 1
  printf '%s\n' "${CCQ_STATE_STEP_STATUSES[idx]}"
}

ccq_state_get_data() {
  local idx
  idx="$(ccq_state_index_of "${1:-}")" || return 1
  printf '%s\n' "${CCQ_STATE_STEP_DATA[idx]}"
}

ccq_normalize_success() {
  case "${1:-}" in
    true|True|TRUE|1|yes|Yes|success|Success) return 0 ;;
    *) return 1 ;;
  esac
}

ccq_capture_step_function() {
  # 运行 step 函数并把 stdout 收集到 CCQ_CAPTURED_STEP_OUTPUT；stderr 直接给用户看。
  local function_name="${1:-}" output_file cmd_status
  CCQ_CAPTURED_STEP_OUTPUT=""
  if ! declare -F "${function_name}" >/dev/null 2>&1; then
    return 127
  fi
  output_file="$(mktemp "${TMPDIR:-/tmp}/ccq-step.XXXXXX")" || return 1
  "${function_name}" >"${output_file}"
  cmd_status=$?
  CCQ_CAPTURED_STEP_OUTPUT="$(cat "${output_file}" 2>/dev/null || true)"
  rm -f "${output_file}"
  return "${cmd_status}"
}

ccq_invoke_step_lifecycle() {
  local step_id="${1:-}" step_name test_function install_function verify_function skip_if_installed
  local test_result install_result install_status result_status verify_result verify_status
  [ -n "${step_id}" ] || return 1
  step_name="$(ccq_get_step_field "${step_id}" StepName || printf '%s' "${step_id}")"
  test_function="$(ccq_get_step_field "${step_id}" TestFunction || true)"
  install_function="$(ccq_get_step_field "${step_id}" InstallFunction || true)"
  verify_function="$(ccq_get_step_field "${step_id}" VerifyFunction || true)"
  skip_if_installed="$(ccq_get_step_field "${step_id}" SkipIfInstalled || printf 'false')"

  ccq_state_set_step "${step_id}" Running

  if [ -n "${test_function}" ] && ccq_capture_step_function "${test_function}"; then
    test_result="${CCQ_CAPTURED_STEP_OUTPUT}"
    if ccq_normalize_success "$(ccq_result_field_from_text "${test_result}" IsInstalled)" &&
      ccq_normalize_success "${skip_if_installed}"; then
      ccq_state_set_step "${step_id}" Skipped "${test_result}"
      ccq_show_step_progress "${step_name}" Skipped "组件已安装，跳过安装"
      return 0
    fi
  fi

  if ! declare -F "${install_function}" >/dev/null 2>&1; then
    ccq_state_set_step "${step_id}" ManualRequired "ErrorMessage=安装函数不存在: ${install_function}"
    ccq_show_step_progress "${step_name}" ManualRequired "ErrorMessage=安装函数不存在"
    return 1
  fi

  ccq_capture_step_function "${install_function}"
  install_status=$?
  install_result="${CCQ_CAPTURED_STEP_OUTPUT}"
  if [ "${install_status}" -ne 0 ] || ! ccq_normalize_success "$(ccq_result_field_from_text "${install_result}" Success)"; then
    result_status="$(ccq_result_field_from_text "${install_result}" Status || true)"
    case "${result_status}" in
      Unsupported|ManualRequired) ccq_state_set_step "${step_id}" "${result_status}" "${install_result}" ;;
      *) ccq_state_set_step "${step_id}" Failed "${install_result}" ;;
    esac
    ccq_show_step_progress "${step_name}" "$(ccq_state_get_status "${step_id}")" "${install_result}"
    return 1
  fi

  if [ -n "${verify_function}" ]; then
    ccq_capture_step_function "${verify_function}"
    verify_status=$?
    verify_result="${CCQ_CAPTURED_STEP_OUTPUT}"
    if [ "${verify_status}" -ne 0 ] || ! ccq_normalize_success "$(ccq_result_field_from_text "${verify_result}" Success)"; then
      ccq_state_set_step "${step_id}" Failed "${verify_result}"
      ccq_show_step_progress "${step_name}" Failed "${verify_result}"
      return 1
    fi
  fi

  ccq_state_set_step "${step_id}" Success "${install_result}"
  ccq_show_step_progress "${step_name}" Success ""
}
