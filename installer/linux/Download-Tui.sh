#!/usr/bin/env bash
# Download-Tui.sh - CCQ 专用下载入口（Linux）
# 功能: 只把 ccq 可执行文件安装到 ~/.local/bin/ccq、设置可执行权限并幂等配置 PATH。
#       不安装 Node.js / Git / Claude Code / Codex / Pi，不依赖 Node，也不进入 installer step 生命周期。
# 说明: 全部 CCQ 行为实现在 core/Ccq.sh；本入口只通过 core/Load.sh 加载共享 runtime，
#       再调用 dedicated 模式的 handoff。

if [ -z "${BASH_VERSION:-}" ]; then
  printf '%s\n' 'Download-Tui.sh 需要 bash 执行：bash installer/linux/Download-Tui.sh' >&2
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

CCQ_PARAM_OUTPUT_MODE="normal"
: "${CCQ_RELEASE_TAG:=__CCQ_RELEASE_TAG__}"

ccq_download_usage() {
  cat <<'EOF'
用法: Download-Tui.sh [OPTIONS]

Options:
  -h, --help   显示帮助

只下载并安装 ccq 管理控制台可执行文件到 ~/.local/bin，并配置 PATH。
不会安装 Node.js / Git / Claude Code / Codex / Pi。需在交互式终端中以普通用户运行。
EOF
}

ccq_download_parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -h|--help)
        ccq_download_usage
        exit 0
        ;;
      *)
        printf '未知参数: %s\n' "$1" >&2
        ccq_download_usage >&2
        exit 2
        ;;
    esac
  done
}

# core 加载顺序唯一声明在 core/Load.sh。
source "${CCQ_LINUX_ROOT}/core/Load.sh"

ccq_download_preflight() {
  if ! ccq_linux_require_runtime_user || ! ccq_linux_check_binary_runtime; then
    ccq_ui_danger "${CCQ_LAST_PLATFORM_ERROR}"
    return 1
  fi
  if ! ccq_command_exists curl && ! ccq_command_exists wget; then
    ccq_ui_danger "缺少 curl 或 wget，无法下载 ccq"
    return 1
  fi
  ccq_require_tty
}

ccq_download_main() {
  ccq_download_parse_args "$@"
  ccq_load_core || return 1
  ccq_download_preflight || return 1
  ccq_confirm_executable_download dedicated
}

ccq_download_main "$@"
