#!/usr/bin/env zsh
# _NpmToolCommon.zsh - macOS npm/npx 工具步骤公共辅助
# 功能: npm 包检测、安装、更新与结果格式化

if [ -n "${CCQ_STEP_NPM_TOOL_COMMON_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_STEP_NPM_TOOL_COMMON_ZSH_LOADED=1

ccq_step_result() {
  printf 'IsInstalled=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'Message=%s\n' "${3:-}"
}

ccq_step_install_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'ErrorMessage=%s\n' "${3:-}"
}

ccq_step_update_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'UpdatedItems=%s\n' "${2:-}"
  printf 'Version=%s\n' "${3:-}"
  printf 'ErrorMessage=%s\n' "${4:-}"
}

ccq_npm_tool_require_npm() {
  ccq_refresh_path
  if ! ccq_command_exists npm; then
    CCQ_NPM_TOOL_ERROR="npm 不可用，请先完成 NodeJS 步骤"
    return 1
  fi
  return 0
}

ccq_npm_tool_require_npx() {
  ccq_refresh_path
  if ! ccq_command_exists npx; then
    CCQ_NPM_TOOL_ERROR="npx 不可用，请先完成 NodeJS 步骤"
    return 1
  fi
  return 0
}

ccq_npm_tool_version_from_command() {
  local command_name="${1:-}"
  [ -n "${command_name}" ] || return 1
  ccq_command_exists "${command_name}" || return 1
  "${command_name}" --version 2>/dev/null | head -n 1 || true
}

ccq_npm_tool_version_from_npm_list() {
  local package_name="${1:-}"
  [ -n "${package_name}" ] || return 1
  ccq_npm_tool_require_npm || return 1
  npm list -g "${package_name}" --depth=0 2>/dev/null | awk -v pkg="${package_name}" '
    index($0, pkg "@") { sub(".*" pkg "@", ""); print; found=1; exit }
    END { if (!found) exit 1 }
  ' || true
}

ccq_npm_tool_command_installed() {
  local command_name="${1:-}"
  [ -n "${command_name}" ] || return 1
  ccq_refresh_path
  ccq_command_exists "${command_name}" || return 1
  "${command_name}" --version >/dev/null 2>&1 || "${command_name}" --help >/dev/null 2>&1
}

ccq_npm_tool_install_latest() {
  local package_name="${1:-}"
  [ -n "${package_name}" ] || { CCQ_NPM_TOOL_ERROR="npm 包名不能为空"; return 1; }
  ccq_npm_tool_require_npm || return 1

  if ! ccq_run_command_developer_or_silent --timeout 300 --retries 3 -- npm install -g "${package_name}@latest"; then
    ccq_run_command --timeout 60 --retries 0 --suppress-output -- npm cache clean --force >/dev/null 2>&1 || true
    if ! ccq_run_command_developer_or_silent --timeout 300 --retries 3 -- npm install -g "${package_name}@latest"; then
      CCQ_NPM_TOOL_ERROR="npm 全局安装失败: ${package_name}"
      return 1
    fi
  fi
  ccq_refresh_path
}

ccq_npx_run() {
  ccq_npm_tool_require_npx || return 1
  ccq_run_command --timeout "${CCQ_DEFAULT_TIMEOUT_SECONDS:-300}" --retries 1 -- npx "$@"
}

ccq_npm_package_has_update() {
  local package_name="${1:-}"
  [ -n "${package_name}" ] || return 1
  ccq_npm_tool_require_npm || return 1

  local outdated_json
  # npm outdated 有可更新包时会返回 exit 1，但 stdout 仍是有效 JSON；不能用 || 追加 {}
  # 否则会形成两个 JSON 文档，导致下游 JSON.parse 报错。
  outdated_json="$(npm outdated -g --json 2>/dev/null)"

  if [ -z "${outdated_json}" ] || [ "${outdated_json}" = "null" ]; then
    outdated_json="{}"
  elif ! printf '%s' "${outdated_json}" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"));' >/dev/null 2>&1; then
    outdated_json="{}"
  fi

  printf '%s' "${outdated_json}" | PKG="${package_name}" node -e '
const outdated = JSON.parse(require("fs").readFileSync(0, "utf8"));
const pkg = process.env.PKG;
console.log(outdated[pkg] ? "true" : "false");
' 2>/dev/null || printf 'false\n'
}
