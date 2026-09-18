#!/usr/bin/env zsh
# Process.zsh - macOS 外部命令执行封装
# 功能: 命令检测、版本提取、超时执行、npm/npx 包装

if [ -n "${CCQ_PROCESS_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_PROCESS_ZSH_LOADED=1

: "${CCQ_DEFAULT_TIMEOUT_SECONDS:=300}"
: "${CCQ_DEFAULT_RETRY_COUNT:=3}"

ccq_command_exists() {
  command -v "$1" >/dev/null 2>&1
}

ccq_resolve_command() {
  command -v "$1" 2>/dev/null || true
}

ccq_join_args_for_display() {
  local command_name="${1:-}"
  shift || true
  local text="${command_name}"
  local arg
  for arg in "$@"; do
    text="${text} ${arg}"
  done
  printf '%s' "${text}"
}

ccq_process_stream_enabled() {
  local suppress_output="${1:-0}"
  [ "${suppress_output}" != "1" ] || return 1
  command -v ccq_output_is_developer >/dev/null 2>&1 || return 1
  ccq_output_is_developer || return 1
  command -v ccq_tty_available >/dev/null 2>&1 || return 1
  ccq_tty_available
}

ccq_process_tty_block() {
  local text="${1:-}"
  [ -n "${text}" ] || return 0
  printf '%s\n' "${text}" > /dev/tty 2>/dev/null || true
}

ccq_run_native_command() {
  if ccq_process_stream_enabled 0; then
    "$@" > >(tee /dev/tty >/dev/null) 2> >(tee /dev/tty >/dev/null)
  else
    "$@" >/dev/null 2>&1
  fi
}

ccq_run_command_once() {
  local timeout_seconds="${1:-${CCQ_DEFAULT_TIMEOUT_SECONDS}}"
  local suppress_output="${2:-0}"
  shift 2 || true

  local output_file error_file heartbeat_file exit_code stream_output=0 heartbeat_pid=""
  output_file="$(mktemp -t ccq_cmd_out.XXXXXX)" || return 1
  error_file="$(mktemp -t ccq_cmd_err.XXXXXX)" || { rm -f "${output_file}"; return 1; }
  heartbeat_file="$(mktemp -t ccq_cmd_heartbeat.XXXXXX)" || { rm -f "${output_file}" "${error_file}"; return 1; }

  if ccq_process_stream_enabled "${suppress_output}"; then
    stream_output=1
    (
      sleep 2 || exit 0
      printf '1' > "${heartbeat_file}" 2>/dev/null || true
      elapsed=2
      while true; do
        printf '\r  等待中... (%s 秒)' "${elapsed}" > /dev/tty 2>/dev/null || true
        sleep 1 || exit 0
        elapsed=$((elapsed + 1))
      done
    ) &
    heartbeat_pid="$!"
  fi

  if ccq_command_exists timeout; then
    timeout "${timeout_seconds}" "$@" >"${output_file}" 2>"${error_file}"
    exit_code=$?
  else
    "$@" >"${output_file}" 2>"${error_file}"
    exit_code=$?
  fi

  if [ -n "${heartbeat_pid}" ]; then
    kill "${heartbeat_pid}" >/dev/null 2>&1 || true
    wait "${heartbeat_pid}" 2>/dev/null || true
    if [ -s "${heartbeat_file}" ]; then
      printf '\n' > /dev/tty 2>/dev/null || true
    fi
  fi

  CCQ_LAST_EXIT_CODE="${exit_code}"
  CCQ_LAST_OUTPUT="$(cat "${output_file}" 2>/dev/null || true)"
  CCQ_LAST_ERROR="$(cat "${error_file}" 2>/dev/null || true)"
  if [ "${exit_code}" -eq 124 ] && [ -z "${CCQ_LAST_ERROR}" ]; then
    CCQ_LAST_ERROR="命令执行超时 (${timeout_seconds} 秒): $(ccq_join_args_for_display "$@")"
  fi
  rm -f "${output_file}" "${error_file}" "${heartbeat_file}"

  if [ "${stream_output}" = "1" ]; then
    ccq_process_tty_block "${CCQ_LAST_OUTPUT}"
    ccq_process_tty_block "${CCQ_LAST_ERROR}"
  elif [ "${suppress_output}" != "1" ] && ! command -v ccq_output_is_developer >/dev/null 2>&1 && [ -n "${CCQ_LAST_OUTPUT}" ]; then
    printf '%s\n' "${CCQ_LAST_OUTPUT}"
  fi

  [ "${exit_code}" -eq 0 ]
}

ccq_run_command() {
  local timeout_seconds="${CCQ_DEFAULT_TIMEOUT_SECONDS}"
  local retry_count="${CCQ_DEFAULT_RETRY_COUNT}"
  local suppress_output=0
  local working_directory=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --timeout)
        timeout_seconds="$2"
        shift 2
        ;;
      --retries)
        retry_count="$2"
        shift 2
        ;;
      --suppress-output)
        suppress_output=1
        shift
        ;;
      --working-directory)
        working_directory="$2"
        shift 2
        ;;
      --)
        shift
        break
        ;;
      *)
        break
        ;;
    esac
  done

  if [ "$#" -eq 0 ]; then
    CCQ_LAST_EXIT_CODE=127
    CCQ_LAST_OUTPUT=""
    CCQ_LAST_ERROR="未提供命令"
    return 127
  fi

  local attempt=0
  local max_attempts=$((retry_count + 1))
  local display_command
  display_command="$(ccq_join_args_for_display "$@")"

  while [ "${attempt}" -lt "${max_attempts}" ]; do
    attempt=$((attempt + 1))
    if [ -n "${working_directory}" ]; then
      (cd "${working_directory}" && ccq_run_command_once "${timeout_seconds}" "${suppress_output}" "$@")
    else
      ccq_run_command_once "${timeout_seconds}" "${suppress_output}" "$@"
    fi
    local command_status=$?
    if [ "${command_status}" -eq 0 ]; then
      return 0
    fi
    if [ "${attempt}" -lt "${max_attempts}" ]; then
      if command -v ccq_ui_runtime_warning >/dev/null 2>&1; then
        ccq_ui_runtime_warning "命令失败，准备重试(${attempt}/${retry_count}): ${display_command}"
      elif command -v ccq_ui_warning >/dev/null 2>&1; then
        ccq_ui_warning "命令失败，准备重试(${attempt}/${retry_count}): ${display_command}" "developer"
      fi
      sleep $((attempt * 2))
    fi
  done

  return "${CCQ_LAST_EXIT_CODE:-1}"
}

ccq_get_command_version() {
  local command_name="${1:-}"
  local output=""
  if [ -z "${command_name}" ] || ! ccq_command_exists "${command_name}"; then
    return 1
  fi

  output="$(${command_name} --version 2>/dev/null | head -n 1 || true)"
  if [ -z "${output}" ]; then
    output="$(${command_name} -v 2>/dev/null | head -n 1 || true)"
  fi
  printf '%s\n' "${output}"
}

ccq_refresh_path() {
  # macOS 当前 shell 通常无需全量刷新；补充常见 Homebrew、nvm 与 npm 前缀。
  local brew_bin="" brew_prefix=""
  if command -v ccq_brew_command >/dev/null 2>&1; then
    brew_bin="$(ccq_brew_command 2>/dev/null || true)"
  elif ccq_command_exists brew; then
    brew_bin="$(command -v brew 2>/dev/null || true)"
  fi
  if [ -n "${brew_bin}" ]; then
    brew_prefix="$("${brew_bin}" --prefix 2>/dev/null || dirname "$(dirname "${brew_bin}")")"
    if [ -n "${brew_prefix}" ]; then
      case ":${PATH}:" in
        *":${brew_prefix}/bin:"*) ;;
        *) PATH="${brew_prefix}/bin:${PATH}" ;;
      esac
      case ":${PATH}:" in
        *":${brew_prefix}/sbin:"*) ;;
        *) PATH="${brew_prefix}/sbin:${PATH}" ;;
      esac
    fi
  fi

  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) PATH="${HOME}/.local/bin:${PATH}" ;;
  esac

  local nvm_dir="${NVM_DIR:-}"
  if [ -z "${nvm_dir}" ]; then
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then
      nvm_dir="${XDG_CONFIG_HOME%/}/nvm"
    else
      nvm_dir="${HOME}/.nvm"
    fi
  fi
  nvm_dir="${nvm_dir%/}"
  if [ -s "${nvm_dir}/nvm.sh" ]; then
    export NVM_DIR="${nvm_dir}"
    . "${nvm_dir}/nvm.sh" >/dev/null 2>&1 || true
    if ccq_command_exists nvm; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent 'lts/*' >/dev/null 2>&1 || true
    fi
  fi

  if ccq_command_exists npm; then
    local npm_prefix
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "${npm_prefix}" ]; then
      case ":${PATH}:" in
        *":${npm_prefix}/bin:"*) ;;
        *) PATH="${npm_prefix}/bin:${PATH}" ;;
      esac
    fi
  fi
  export PATH
}

ccq_npm_global_install() {
  local package_name="${1:-}"
  local version="${2:-}"
  local full_package="${package_name}"
  if [ -z "${package_name}" ]; then
    CCQ_LAST_ERROR="npm 包名不能为空"
    return 1
  fi
  if [ -n "${version}" ]; then
    full_package="${package_name}@${version}"
  fi
  ccq_run_command --timeout 300 --retries 3 -- npm install -g "${full_package}"
}

ccq_run_command_developer_or_silent() {
  if command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer; then
    ccq_run_command "$@"
  else
    ccq_run_command --suppress-output "$@" >/dev/null 2>&1
  fi
}

ccq_npx() {
  ccq_run_command --timeout "${CCQ_DEFAULT_TIMEOUT_SECONDS}" --retries 0 -- npx "$@"
}

# npm outdated 全局缓存 - 会话级缓存避免重复查询
CCQ_NPM_OUTDATED_CACHE=""
CCQ_NPM_OUTDATED_CACHED=0

ccq_npm_outdated_global() {
  local force="${1:-0}"

  # 缓存命中且非强制刷新
  if [ "${CCQ_NPM_OUTDATED_CACHED}" = "1" ] && [ "${force}" != "1" ]; then
    printf '%s' "${CCQ_NPM_OUTDATED_CACHE}"
    return 0
  fi

  # npm 不可用时返回空字符串
  if ! ccq_command_exists npm; then
    CCQ_NPM_OUTDATED_CACHE=""
    CCQ_NPM_OUTDATED_CACHED=1
    return 0
  fi

  # 解析 npm 全局前缀，处理 fnm 符号链接
  local npm_prefix
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"

  # fnm 路径修复：解析 /fnm_multishells/ 或 /.fnm/ 的真实路径
  if [ -n "${npm_prefix}" ]; then
    case "${npm_prefix}" in
      *"/fnm_multishells/"*|*"/.fnm/"*)
        if ccq_command_exists readlink; then
          npm_prefix="$(readlink -f "${npm_prefix}" 2>/dev/null || true)"
        fi
        if [ -z "${npm_prefix}" ] && ccq_command_exists realpath; then
          npm_prefix="$(realpath "${npm_prefix}" 2>/dev/null || true)"
        fi
        ;;
    esac
  fi

  # 执行 npm outdated 查询
  local npm_args=("outdated" "-g" "--json")
  if [ -n "${npm_prefix}" ]; then
    npm_args+=("--prefix" "${npm_prefix}")
  fi

  local outdated_json
  outdated_json="$(npm "${npm_args[@]}" 2>/dev/null || true)"

  # 解析 JSON 转 TSV 格式: <package_name><TAB><current><TAB><latest>
  local tsv_output=""
  if [ -n "${outdated_json}" ]; then
    tsv_output="$(node -e "
      try {
        const data = JSON.parse(process.argv[1]);
        const lines = [];
        for (const [pkg, info] of Object.entries(data)) {
          const current = info.current || '';
          const latest = info.latest || '';
          lines.push(\`\${pkg}\t\${current}\t\${latest}\`);
        }
        console.log(lines.join('\\n'));
      } catch (e) {
        // JSON 解析失败返回空
      }
    " "${outdated_json}" 2>/dev/null || true)"
  fi

  # 更新缓存
  CCQ_NPM_OUTDATED_CACHE="${tsv_output}"
  CCQ_NPM_OUTDATED_CACHED=1

  printf '%s' "${tsv_output}"
}

# ============ Unified Test Framework ============

# 会话级测试结果缓存
typeset -gA CCQ_TEST_RESULT_CACHE

ccq_get_cached_test_result() {
  local cache_key="${1:-}"
  local ttl_seconds="${2:-30}"
  [ -z "${cache_key}" ] && return 1

  local cache_entry="${CCQ_TEST_RESULT_CACHE[${cache_key}]:-}"
  [ -z "${cache_entry}" ] && return 1

  local created_at="${cache_entry%%:*}"
  local now="$(date +%s)"
  local elapsed=$((now - created_at))

  [ ${elapsed} -le ${ttl_seconds} ] || { unset "CCQ_TEST_RESULT_CACHE[${cache_key}]"; return 1; }

  printf '%s\n' "${cache_entry#*:}"
}

ccq_set_cached_test_result() {
  local cache_key="${1:-}"
  local result="${2:-}"
  [ -z "${cache_key}" ] && return 1

  local now="$(date +%s)"
  CCQ_TEST_RESULT_CACHE[${cache_key}]="${now}:${result}"
}

ccq_clear_test_cache() {
  local step_id="${1:-}"
  if [ -z "${step_id}" ]; then
    CCQ_TEST_RESULT_CACHE=()
  else
    unset "CCQ_TEST_RESULT_CACHE[${step_id}]"
  fi
}

ccq_resolve_json_path() {
  local json="${1:-}"
  local path="${2:-}"
  [ -z "${json}" ] || [ -z "${path}" ] && return 1

  node -e "
    try {
      const data = JSON.parse(process.argv[1]);
      const segments = process.argv[2].split('.');
      let current = data;
      for (const seg of segments) {
        if (current == null) { process.exit(1); }
        current = current[seg];
      }
      if (current != null) { console.log(current); }
    } catch (e) { process.exit(1); }
  " "${json}" "${path}" 2>/dev/null
}

ccq_test_path_structure() {
  local checks_json="${1:-}"
  [ -z "${checks_json}" ] && { printf '{"allPassed":false,"details":[]}'; return 0; }

  local all_passed=1
  local details="[]"

  details="$(node -e "
    const checks = JSON.parse(process.argv[1]);
    const fs = require('fs');
    const path = require('path');
    const details = [];
    let allPassed = true;

    for (const check of checks) {
      let passed = false;
      let info = '';

      if (check.type === 'dir') {
        passed = fs.existsSync(check.path) && fs.statSync(check.path).isDirectory();
        if (passed && check.filter && check.minCount !== undefined) {
          const files = fs.readdirSync(check.path).filter(f => f.includes(check.filter));
          passed = files.length >= check.minCount;
          info = \`found \${files.length}/\${check.minCount}\`;
        }
      } else if (check.type === 'file') {
        passed = fs.existsSync(check.path) && fs.statSync(check.path).isFile();
        if (passed && check.contentMatch) {
          const content = fs.readFileSync(check.path, 'utf8');
          passed = new RegExp(check.contentMatch).test(content);
          if (!passed) info = 'content mismatch';
        }
      }

      if (!passed) allPassed = false;
      details.push({ path: check.path, passed, info });
    }

    console.log(JSON.stringify({ allPassed, details }));
  " "${checks_json}" 2>/dev/null || printf '{"allPassed":false,"details":[]}')"

  printf '%s' "${details}"
}

ccq_test_json_config() {
  local file_path="${1:-}"
  local required_fields_json="${2:-[]}"
  local required_array_items_json="${3:-[]}"
  [ ! -f "${file_path}" ] && { printf '{"allPassed":false,"missingFields":[],"parseError":"file not found"}'; return 0; }

  local result
  result="$(node -e "
    const fs = require('fs');
    const filePath = process.argv[1];
    const requiredFields = JSON.parse(process.argv[2]);
    const requiredArrayItems = JSON.parse(process.argv[3]);

    let json, parseError = '';
    try {
      json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.log(JSON.stringify({ allPassed: false, missingFields: [], parseError: 'JSON parse failed: ' + e.message }));
      process.exit(0);
    }

    const resolveJsonPath = (obj, path) => {
      const segments = path.split('.');
      let current = obj;
      for (const seg of segments) {
        if (current == null) return null;
        current = current[seg];
      }
      return current;
    };

    let allPassed = true;
    const missingFields = [];

    for (const field of requiredFields) {
      const value = resolveJsonPath(json, field.path);
      const mode = field.matchMode || 'Exists';
      let passed = false;

      if (mode === 'Exists') {
        passed = value != null && value !== '';
      } else if (mode === 'Exact') {
        passed = String(value) === String(field.expectedValue || '');
      } else if (mode === 'Contains') {
        passed = String(value).includes(String(field.expectedValue || ''));
      }

      if (!passed) {
        allPassed = false;
        missingFields.push(field.path);
      }
    }

    for (const arrayCheck of requiredArrayItems) {
      const array = resolveJsonPath(json, arrayCheck.path);
      if (!Array.isArray(array)) {
        allPassed = false;
        missingFields.push(arrayCheck.path);
        continue;
      }
      for (const item of arrayCheck.items) {
        if (!array.includes(item)) {
          allPassed = false;
          missingFields.push(\`\${arrayCheck.path}::\${item}\`);
        }
      }
    }

    console.log(JSON.stringify({ allPassed, missingFields, parsedJson: json }));
  " "${file_path}" "${required_fields_json}" "${required_array_items_json}" 2>/dev/null || printf '{"allPassed":false,"missingFields":[],"parseError":"node execution failed"}')"

  printf '%s' "${result}"
}

ccq_invoke_unified_check() {
  local step_id="${1:-}"; shift || true
  local display_name="${step_id}"
  local command="" min_version="" path_checks_json="[]" config_file=""
  local required_fields_json="[]" required_array_items_json="[]"
  local custom_verify="" use_cache=0 quiet=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --display-name) display_name="$2"; shift 2 ;;
      --command) command="$2"; shift 2 ;;
      --min-version) min_version="$2"; shift 2 ;;
      --path-checks) path_checks_json="$2"; shift 2 ;;
      --config-file) config_file="$2"; shift 2 ;;
      --required-fields) required_fields_json="$2"; shift 2 ;;
      --required-array-items) required_array_items_json="$2"; shift 2 ;;
      --custom-verify) custom_verify="$2"; shift 2 ;;
      --use-cache) use_cache=1; shift ;;
      --quiet) quiet=1; shift ;;
      *) shift ;;
    esac
  done

  # 缓存检查
  if [ ${use_cache} -eq 1 ]; then
    local cached
    cached="$(ccq_get_cached_test_result "${step_id}" 30 2>/dev/null || true)"
    if [ -n "${cached}" ]; then
      printf '%s\n' "${cached}"
      return 0
    fi
  fi

  local is_installed=0 version="" message="${display_name} 未安装"

  # CLI 命令检测
  if [ -n "${command}" ]; then
    if ccq_command_exists "${command}"; then
      is_installed=1
      version="$(ccq_get_command_version "${command}" 2>/dev/null || true)"
      message="${display_name} 已安装"

      # 版本比较（简化逻辑：仅比较主版本号）
      if [ -n "${min_version}" ] && [ -n "${version}" ]; then
        local current_major="${version%%.*}"
        local required_major="${min_version%%.*}"
        if [ "${current_major}" -lt "${required_major}" ] 2>/dev/null; then
          is_installed=0
          message="${display_name} 版本过低 (当前: ${version}, 需要: ${min_version}+)"
        fi
      fi
    else
      is_installed=0
      message="${display_name} 命令不存在"
    fi

    [ ${is_installed} -eq 0 ] && {
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    }
  fi

  # 目录结构检测
  if [ "${path_checks_json}" != "[]" ]; then
    local path_result
    path_result="$(ccq_test_path_structure "${path_checks_json}")"
    local all_passed
    all_passed="$(printf '%s' "${path_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).allPassed' 2>/dev/null || echo false)"

    if [ "${all_passed}" != "true" ]; then
      is_installed=0
      message="${display_name} 目录结构不完整"
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    fi
  fi

  # 配置文件检测
  if [ -n "${config_file}" ]; then
    local config_result
    config_result="$(ccq_test_json_config "${config_file}" "${required_fields_json}" "${required_array_items_json}")"
    local parse_error
    parse_error="$(printf '%s' "${config_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).parseError || ""' 2>/dev/null || true)"

    if [ -n "${parse_error}" ]; then
      is_installed=0
      message="${display_name} 配置解析失败: ${parse_error}"
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    fi

    local all_passed
    all_passed="$(printf '%s' "${config_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).allPassed' 2>/dev/null || echo false)"

    if [ "${all_passed}" != "true" ]; then
      is_installed=0
      local missing_fields
      missing_fields="$(printf '%s' "${config_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).missingFields.join(", ")' 2>/dev/null || true)"
      message="${display_name} 配置不完整: ${missing_fields}"
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    fi
  fi

  # 自定义验证
  if [ -n "${custom_verify}" ]; then
    local custom_result
    custom_result="$(eval "${custom_verify}" 2>/dev/null || echo "0")"
    if [ "${custom_result}" = "0" ] || [ "${custom_result}" = "false" ]; then
      is_installed=0
      message="${display_name} 自定义验证未通过"
    elif [ "${custom_result}" != "1" ] && [ "${custom_result}" != "true" ]; then
      version="${custom_result}"
    fi
  fi

  # 全部通过
  [ ${is_installed} -eq 0 ] && is_installed=1
  [ -z "${message}" ] || [ "${message}" = "${display_name} 未安装" ] && message="${display_name} 已安装"

  local final_result="{\"isInstalled\":${is_installed},\"version\":\"${version}\",\"message\":\"${message}\"}"

  # UI 输出
  if [ ${quiet} -eq 0 ]; then
    if [ ${is_installed} -eq 1 ]; then
      local version_suffix=""
      [ -n "${version}" ] && version_suffix=" (版本: ${version})"
      command -v ccq_ui_success >/dev/null 2>&1 && ccq_ui_success "✓ ${display_name} 已安装${version_suffix}"
    else
      command -v ccq_ui_warning >/dev/null 2>&1 && ccq_ui_warning "⚠ ${display_name} [FAIL]: ${message}"
    fi
  fi

  # 写入缓存
  [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${final_result}"

  printf '%s\n' "${final_result}"
}
