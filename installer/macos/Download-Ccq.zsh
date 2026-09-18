#!/usr/bin/env zsh
# Download-Ccq.zsh - CCQ 专用下载入口（macOS）
# 功能: 只把 ccq 可执行文件安装到 ~/.local/bin/ccq、设置可执行权限并幂等配置 PATH。
#       不安装、不更新 Node.js / Git / Claude Code / Codex / Pi，也不进入 installer step 生命周期。
# 说明: 全部 CCQ 行为实现在 core/Ccq.zsh；本入口只通过 core/Load.zsh 加载共享 runtime，
#       再调用 dedicated 模式的 handoff。

if [ -z "${ZSH_VERSION:-}" ]; then
  if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ] && [ -x "/bin/zsh" ]; then
    exec /bin/zsh "${BASH_SOURCE[0]}" "$@"
  fi
  if [ -x "/bin/zsh" ]; then
    ccq_streamed_script="$(mktemp "${TMPDIR:-/tmp}/ccq-download-ccq.XXXXXX")" || exit 1
    cat > "${ccq_streamed_script}"
    export CCQ_STREAMED_SCRIPT_PATH="${ccq_streamed_script}"
    exec /bin/zsh "${ccq_streamed_script}" "$@"
  fi
  printf '%s\n' 'Download-Ccq.zsh 需要 zsh 执行；云端 built 入口会自动切换到 /bin/zsh。' >&2
  exit 1
fi

if [ -n "${CCQ_STREAMED_SCRIPT_PATH:-}" ]; then
  trap 'rm -f "${CCQ_STREAMED_SCRIPT_PATH}"' EXIT
fi

setopt NO_NOMATCH
setopt PIPE_FAIL
setopt SH_WORD_SPLIT

# 避免继承上游 zsh xtrace，防止内部变量赋值污染输出。
set +x 2>/dev/null || true
unsetopt XTRACE 2>/dev/null || true
setopt NO_XTRACE 2>/dev/null || true

CCQ_MACOS_ROOT="$(cd "$(dirname "${0:A}")" && pwd)"
CCQ_INSTALLER_ROOT="$(cd "${CCQ_MACOS_ROOT}/.." && pwd)"
export CCQ_MACOS_ROOT CCQ_INSTALLER_ROOT

CCQ_PARAM_OUTPUT_MODE="normal"
: "${CCQ_RELEASE_TAG:=__CCQ_RELEASE_TAG__}"

ccq_download_usage() {
  cat <<'EOF'
用法: Download-Ccq.zsh [OPTIONS]

Options:
  -h, --help   显示帮助

只下载并安装 ccq 管理控制台可执行文件到 ~/.local/bin，并配置 PATH。
不会安装 Node.js / Git / Claude Code / Codex / Pi。
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

# core 加载顺序唯一声明在 core/Load.zsh；本入口不再出现 core 文件列表。
# macOS 侧不能用 build.json 做 manifest 驱动（JSON 读取依赖 node，专用入口不能依赖 node），
# 由 installer/contracts/Test-Contracts.ps1 断言 Load.zsh 与 build.json 的 CoreFiles 集合一致。
source "${CCQ_MACOS_ROOT}/core/Load.zsh"

ccq_download_main() {
  ccq_download_parse_args "$@"
  ccq_load_core
  ccq_confirm_executable_download dedicated
}

ccq_download_main "$@"
