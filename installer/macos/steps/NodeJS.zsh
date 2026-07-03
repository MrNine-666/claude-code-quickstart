#!/usr/bin/env zsh
# NodeJS.zsh - macOS Node.js / fnm / nvm 安装步骤
# 功能: 优先复用现有 node/npm；不达标时优先使用当前 fnm/nvm 安装/切换 LTS，最后用 nvm 官方脚本兜底

if [ -n "${CCQ_STEP_NODEJS_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_STEP_NODEJS_ZSH_LOADED=1

: "${CCQ_REQUIRED_NODE_MAJOR:=20}"
: "${CCQ_NVM_INSTALL_URL:=https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh}"

ccq_nodejs_result() {
  printf 'IsInstalled=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'Message=%s\n' "${3:-}"
}

ccq_nodejs_install_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'NpmVersion=%s\n' "${3:-}"
  printf 'ErrorMessage=%s\n' "${4:-}"
}

ccq_nodejs_major() {
  local version="${1:-}"
  version="${version#v}"
  printf '%s' "${version%%.*}"
}

ccq_nodejs_versions_ok() {
  if ! ccq_command_exists node || ! ccq_command_exists npm; then
    return 1
  fi
  local node_version node_major
  node_version="$(node --version 2>/dev/null || true)"
  node_major="$(ccq_nodejs_major "${node_version}")"
  [ -n "${node_major}" ] && [ "${node_major}" -ge "${CCQ_REQUIRED_NODE_MAJOR}" ]
}

ccq_nodejs_command_path() {
  local command_name="${1:-}"
  [ -z "${command_name}" ] && return 1
  command -v "${command_name}" 2>/dev/null || true
}

ccq_nodejs_command_source() {
  local command_path="${1:-}"
  [ -z "${command_path}" ] && {
    printf '%s' 'unknown'
    return 0
  }

  case "${command_path}" in
    */.fnm/*|*/fnm/node-versions/*|*/fnm_multishells/*)
      printf '%s' 'fnm'
      return 0
      ;;
    */.nvm/*|*/nvm/versions/node/*)
      printf '%s' 'nvm'
      return 0
      ;;
    /opt/homebrew/*|/usr/local/*)
      printf '%s' 'homebrew'
      return 0
      ;;
    *)
      printf '%s' 'portable'
      return 0
      ;;
  esac
}

ccq_nodejs_active_provider() {
  local node_path npm_path node_source npm_source
  node_path="$(ccq_nodejs_command_path node)"
  npm_path="$(ccq_nodejs_command_path npm)"
  if [ -z "${node_path}" ] && [ -z "${npm_path}" ]; then
    if ccq_nodejs_load_nvm >/dev/null 2>&1; then
      printf '%s' 'nvm'
      return 0
    fi
    printf '%s' 'none'
    return 0
  fi

  node_source="$(ccq_nodejs_command_source "${node_path}")"
  npm_source="$(ccq_nodejs_command_source "${npm_path}")"
  if [ -n "${node_path}" ] && [ -n "${npm_path}" ] && [ "${node_source}" != "${npm_source}" ] && [ "${npm_source}" != "unknown" ]; then
    printf '%s' 'unknown'
    return 0
  fi
  if [ -n "${node_path}" ]; then
    printf '%s' "${node_source}"
  else
    printf '%s' "${npm_source}"
  fi
}

ccq_nodejs_nvm_dir() {
  if [ -n "${NVM_DIR:-}" ]; then
    printf '%s\n' "${NVM_DIR%/}"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s\n' "${XDG_CONFIG_HOME%/}/nvm"
  else
    printf '%s\n' "${HOME}/.nvm"
  fi
}

ccq_nodejs_load_nvm() {
  local nvm_dir nvm_script
  nvm_dir="$(ccq_nodejs_nvm_dir)"
  nvm_script="${nvm_dir}/nvm.sh"
  export NVM_DIR="${nvm_dir}"
  CCQ_NODEJS_LOAD_ERROR=""

  if [ ! -f "${nvm_script}" ]; then
    CCQ_NODEJS_LOAD_ERROR="nvm.sh 不存在: ${nvm_script}"
    return 1
  fi
  if [ ! -s "${nvm_script}" ]; then
    CCQ_NODEJS_LOAD_ERROR="nvm.sh 为空: ${nvm_script}"
    return 1
  fi
  if [ ! -r "${nvm_script}" ]; then
    CCQ_NODEJS_LOAD_ERROR="nvm.sh 不可读: ${nvm_script}"
    return 1
  fi
  if ! . "${nvm_script}" >/dev/null 2>&1; then
    CCQ_NODEJS_LOAD_ERROR="source ${nvm_script} 失败"
    return 1
  fi
  if ! command -v nvm >/dev/null 2>&1; then
    CCQ_NODEJS_LOAD_ERROR="已加载 ${nvm_script}，但未定义 nvm 函数"
    return 1
  fi
}

ccq_nodejs_extract_nvm_error() {
  local output_file="${1:-}"
  local line last_line=""
  if [ -z "${output_file}" ] || [ ! -f "${output_file}" ]; then
    printf '%s' 'nvm 官方安装脚本执行失败'
    return 0
  fi

  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    case "${line}" in
      *"Close and reopen"*|*"run the following"*|*"This loads nvm"*|export\ NVM_DIR*)
        continue
        ;;
    esac
    last_line="${line}"
    case "${line}" in
      *"Xcode Command Line Developer Tools"*|*"xcode-select --install"*)
        printf '%s' '缺少 Xcode Command Line Tools，请执行 xcode-select --install 后重试'
        return 0
        ;;
      *"Failed to clone"*|*"Failed to fetch"*|*"Failed to download"*|*"Could not resolve host"*|*"SSL"*|*"Connection"*"failed"*)
        printf '%s' "${line}"
        return 0
        ;;
      *"Permission denied"*|*"has the same name as installation directory"*|*"directory does not exist"*)
        printf '%s' "${line}"
        return 0
        ;;
    esac
  done < "${output_file}"

  [ -n "${last_line}" ] && printf '%s' "${last_line}" || printf '%s' '未获取到 nvm 安装输出'
}

ccq_nodejs_install_nvm_official() {
  if ccq_nodejs_load_nvm; then
    return 0
  fi
  if ! ccq_command_exists curl; then
    CCQ_NODEJS_ERROR="curl 不可用，无法安装 nvm"
    return 1
  fi
  if ! ccq_command_exists bash; then
    CCQ_NODEJS_ERROR="bash 不可用，无法执行 nvm 官方安装脚本"
    return 1
  fi

  local output_file error_hint
  output_file="$(mktemp "${TMPDIR:-/tmp}/ccq-nvm-install.XXXXXX")" || {
    CCQ_NODEJS_ERROR="无法创建 nvm 安装日志临时文件"
    return 1
  }

  if ! bash -c "set -o pipefail; curl -fsSL '${CCQ_NVM_INSTALL_URL}' | bash" >"${output_file}" 2>&1; then
    command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer && ccq_process_tty_block "$(cat "${output_file}" 2>/dev/null || true)"
    error_hint="$(ccq_nodejs_extract_nvm_error "${output_file}")"
    rm -f "${output_file}"
    CCQ_NODEJS_ERROR="nvm 官方安装脚本执行失败：${error_hint}"
    return 1
  fi
  command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer && ccq_process_tty_block "$(cat "${output_file}" 2>/dev/null || true)"

  if ! ccq_nodejs_load_nvm; then
    error_hint="${CCQ_NODEJS_LOAD_ERROR:-$(ccq_nodejs_extract_nvm_error "${output_file}")}"
    rm -f "${output_file}"
    CCQ_NODEJS_ERROR="nvm 已安装但当前会话未能加载：${error_hint}；请重新打开终端或执行 source \"$(ccq_nodejs_nvm_dir)/nvm.sh\""
    return 1
  fi
  rm -f "${output_file}"
}

ccq_nodejs_install_via_nvm() {
  if ! ccq_nodejs_install_nvm_official; then
    return 1
  fi

  if ! ccq_run_native_command nvm install --lts; then
    CCQ_NODEJS_ERROR="Node.js LTS 安装失败"
    return 1
  fi
  if ! ccq_run_native_command nvm alias default 'lts/*'; then
    CCQ_NODEJS_ERROR="nvm default alias 设置失败"
    return 1
  fi
  if ! ccq_run_native_command nvm use default; then
    CCQ_NODEJS_ERROR="nvm use default 失败"
    return 1
  fi
}

ccq_nodejs_install_via_existing_nvm() {
  if ! ccq_nodejs_load_nvm; then
    CCQ_NODEJS_ERROR="检测到 nvm，但当前会话无法加载：${CCQ_NODEJS_LOAD_ERROR:-未知错误}"
    return 1
  fi
  ccq_nodejs_install_via_nvm
}

ccq_nodejs_install_via_fnm() {
  if ! ccq_command_exists fnm; then
    CCQ_NODEJS_ERROR="fnm 命令不可用，无法通过当前 fnm 安装 Node.js LTS"
    return 1
  fi

  if ! ccq_run_native_command fnm install --lts; then
    CCQ_NODEJS_ERROR="fnm install --lts 失败"
    return 1
  fi
  if ! ccq_run_native_command fnm default lts-latest; then
    CCQ_NODEJS_ERROR="fnm default lts-latest 失败"
    return 1
  fi
  if ! ccq_run_native_command fnm use --install-if-missing lts-latest; then
    CCQ_NODEJS_ERROR="fnm use lts-latest 失败"
    return 1
  fi
  ccq_refresh_path
}

ccq_nodejs_install_runtime_lts() {
  local active_provider="${1:-}"
  case "${active_provider}" in
    fnm)
      ccq_nodejs_install_via_fnm
      return $?
      ;;
    nvm)
      ccq_nodejs_install_via_existing_nvm
      return $?
      ;;
    *)
      ccq_nodejs_install_via_nvm
      return $?
      ;;
  esac
}

Test-NodeJSInstalled() {
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_result true "$(node --version 2>/dev/null || true)" "Node.js 与 npm 已就绪"
    return 0
  fi

  # 当前 PATH 不满足时再刷新常见路径 / nvm default 作为兜底；避免一开始就 source nvm
  # 覆盖用户当前已可用的 fnm/Homebrew/直装 Node.js。
  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_result true "$(node --version 2>/dev/null || true)" "Node.js 与 npm 已就绪"
    return 0
  fi

  local active_provider
  active_provider="$(ccq_nodejs_active_provider)"
  case "${active_provider}" in
    fnm)
      ccq_nodejs_result false "$(node --version 2>/dev/null || true)" "Node.js 未安装、npm 不可用或版本低于 v${CCQ_REQUIRED_NODE_MAJOR}，将通过当前 fnm 安装/切换 LTS"
      ;;
    nvm)
      ccq_nodejs_result false "$(node --version 2>/dev/null || true)" "Node.js 未安装、npm 不可用或版本低于 v${CCQ_REQUIRED_NODE_MAJOR}，将通过当前 nvm 安装/切换 LTS"
      ;;
    *)
      ccq_nodejs_result false "$(node --version 2>/dev/null || true)" "Node.js 未安装、npm 不可用或版本低于 v${CCQ_REQUIRED_NODE_MAJOR}，将通过 nvm 官方脚本安装 Node.js"
      ;;
  esac
}

Install-NodeJS() {
  local error_message="" active_provider=""

  if ccq_nodejs_versions_ok; then
    ccq_nodejs_install_result true "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" ""
    return 0
  fi

  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_install_result true "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" ""
    return 0
  fi

  active_provider="$(ccq_nodejs_active_provider)"
  ccq_nodejs_install_runtime_lts "${active_provider}" || {
    error_message="${CCQ_NODEJS_ERROR:-安装 Node.js LTS 失败}"
    ccq_nodejs_install_result false "" "" "${error_message}"
    return 1
  }

  ccq_refresh_path
  if ! ccq_nodejs_versions_ok; then
    error_message="Node.js 安装后验证失败"
    ccq_nodejs_install_result false "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" "${error_message}"
    return 1
  fi

  ccq_nodejs_install_result true "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" ""
}

Verify-NodeJS() {
  if ccq_nodejs_versions_ok; then
    printf 'Success=true\n'
    printf 'ErrorMessage=\n'
    return 0
  fi

  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    printf 'Success=true\n'
    printf 'ErrorMessage=\n'
    return 0
  fi

  printf 'Success=false\n'
  printf 'ErrorMessage=Node.js 或 npm 验证失败\n'
  return 1
}
