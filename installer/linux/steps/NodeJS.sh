#!/usr/bin/env bash
# NodeJS.sh - Linux Node.js 安装步骤
# 功能: runtime-first：现有 node/npm 达标即复用；当前 provider 为 nvm/fnm 时只在其内安装 LTS；
#       否则用固定版本的 nvm 官方脚本做用户级兜底。不使用发行版包管理器安装系统 Node，
#       不迁移 provider、PATH 或全局 npm 包。

: "${CCQ_REQUIRED_NODE_MAJOR:=20}"
# nvm 官方脚本版本唯一声明处（与 macOS 兜底版本保持一致）。
CCQ_NVM_VERSION="v0.40.4"
: "${CCQ_NVM_INSTALL_URL:=https://raw.githubusercontent.com/nvm-sh/nvm/${CCQ_NVM_VERSION}/install.sh}"

ccq_nodejs_result() {
  printf 'IsInstalled=%s\nVersion=%s\nMessage=%s\n' "${1:-false}" "${2:-}" "${3:-}"
}

ccq_nodejs_install_result() {
  printf 'Success=%s\nVersion=%s\nNpmVersion=%s\nErrorMessage=%s\n' "${1:-false}" "${2:-}" "${3:-}" "${4:-}"
}

ccq_nodejs_versions_ok() {
  ccq_command_exists node && ccq_command_exists npm || return 1
  local node_version node_major
  node_version="$(node --version 2>/dev/null || true)"
  node_version="${node_version#v}"
  node_major="${node_version%%.*}"
  [[ "${node_major}" =~ ^[0-9]+$ ]] && [ "${node_major}" -ge "${CCQ_REQUIRED_NODE_MAJOR}" ]
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
  local nvm_script
  NVM_DIR="$(ccq_nodejs_nvm_dir)"
  export NVM_DIR
  nvm_script="${NVM_DIR}/nvm.sh"
  [ -s "${nvm_script}" ] && [ -r "${nvm_script}" ] || return 1
  . "${nvm_script}" >/dev/null 2>&1 || return 1
  declare -F nvm >/dev/null 2>&1
}

ccq_nodejs_active_provider() {
  # 按当前 node 所在路径判断 provider；没有 node 但 nvm 可加载时视为 nvm。
  local node_path
  node_path="$(command -v node 2>/dev/null || true)"
  case "${node_path}" in
    */.fnm/*|*/fnm/node-versions/*|*/fnm_multishells/*) printf 'fnm' ;;
    */.nvm/*|*/nvm/versions/node/*) printf 'nvm' ;;
    '')
      if ccq_nodejs_load_nvm; then printf 'nvm'
      elif ccq_command_exists fnm; then printf 'fnm'
      else printf 'none'
      fi
      ;;
    *) printf 'other' ;;
  esac
}

ccq_nodejs_install_nvm_official() {
  ccq_nodejs_load_nvm && return 0
  if ! ccq_command_exists curl && ! ccq_command_exists wget; then
    CCQ_NODEJS_ERROR="curl 与 wget 均不可用，无法下载 nvm 官方安装脚本"
    return 1
  fi
  ccq_ui_info "正在通过 nvm ${CCQ_NVM_VERSION} 官方脚本安装 nvm..." >&2
  if ! (
    set -o pipefail
    if ccq_command_exists curl; then
      curl -fsSL "${CCQ_NVM_INSTALL_URL}" | bash
    else
      wget -qO- "${CCQ_NVM_INSTALL_URL}" | bash
    fi
  ) >&2; then
    CCQ_NODEJS_ERROR="nvm 官方安装脚本执行失败"
    return 1
  fi
  if ! ccq_nodejs_load_nvm; then
    CCQ_NODEJS_ERROR="nvm 已安装但当前会话未能加载；请重新打开终端或执行 source \"$(ccq_nodejs_nvm_dir)/nvm.sh\""
    return 1
  fi
}

ccq_nodejs_install_via_nvm() {
  ccq_run_native_command nvm install --lts || { CCQ_NODEJS_ERROR="nvm install --lts 失败"; return 1; }
  ccq_run_native_command nvm alias default 'lts/*' || { CCQ_NODEJS_ERROR="nvm alias default 失败"; return 1; }
  ccq_run_native_command nvm use default || { CCQ_NODEJS_ERROR="nvm use default 失败"; return 1; }
}

ccq_nodejs_install_via_fnm() {
  ccq_run_native_command fnm install --lts || { CCQ_NODEJS_ERROR="fnm install --lts 失败"; return 1; }
  ccq_run_native_command fnm default lts-latest || { CCQ_NODEJS_ERROR="fnm default lts-latest 失败"; return 1; }
  ccq_refresh_path
}

Test-NodeJSInstalled() {
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_result true "$(node --version 2>/dev/null)" "Node.js 与 npm 已就绪"
    return 0
  fi
  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_result true "$(node --version 2>/dev/null)" "Node.js 与 npm 已就绪"
    return 0
  fi
  ccq_nodejs_result false "$(node --version 2>/dev/null || true)" "Node.js 未安装、npm 不可用或版本低于 v${CCQ_REQUIRED_NODE_MAJOR}"
}

Install-NodeJS() {
  local provider
  CCQ_NODEJS_ERROR=""
  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_install_result true "$(node --version 2>/dev/null)" "$(npm --version 2>/dev/null)" ""
    return 0
  fi

  provider="$(ccq_nodejs_active_provider)"
  case "${provider}" in
    fnm)
      ccq_ui_info "检测到 fnm，将在 fnm 内安装 Node.js LTS" >&2
      ccq_nodejs_install_via_fnm
      ;;
    nvm)
      ccq_ui_info "检测到 nvm，将在 nvm 内安装 Node.js LTS" >&2
      ccq_nodejs_load_nvm && ccq_nodejs_install_via_nvm
      ;;
    *)
      ccq_nodejs_install_nvm_official && ccq_nodejs_install_via_nvm
      ;;
  esac || {
    ccq_nodejs_install_result false "" "" "${CCQ_NODEJS_ERROR:-安装 Node.js LTS 失败}"
    return 1
  }

  ccq_refresh_path
  if ! ccq_nodejs_versions_ok; then
    ccq_nodejs_install_result false "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" "Node.js 安装后验证失败"
    return 1
  fi
  ccq_nodejs_install_result true "$(node --version 2>/dev/null)" "$(npm --version 2>/dev/null)" ""
}

Verify-NodeJS() {
  if ccq_nodejs_versions_ok; then
    printf 'Success=true\nErrorMessage=\n'
    return 0
  fi
  printf 'Success=false\nErrorMessage=Node.js 或 npm 验证失败\n'
  return 1
}
