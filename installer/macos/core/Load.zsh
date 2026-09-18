#!/usr/bin/env zsh
# Load.zsh - macOS core 加载顺序与加载函数的唯一声明处
# 功能: 以唯一一份有序声明 CCQ_CORE_ORDER 驱动 source 模式 core 加载。
# 说明: Install.zsh 与 Download-Ccq.zsh 都只 source 本文件并调用 ccq_load_core，
#       入口内不得再出现 core 文件列表。
#
# 为什么这里不能用 installer/contracts/build.json 做 manifest 驱动：
# macOS 侧读取 JSON 只能依赖 node（见 core/Json.zsh 与 core/Registry.zsh），
# 而 CCQ 专用下载入口恰恰不能依赖 node。因此加载顺序只能在本文件声明一次，
# 由 installer/contracts/Test-Contracts.ps1 断言本文件的 CCQ_CORE_ORDER 与
# build.json 中 MacOS.Artifacts[*].CoreFiles 的集合一致；一旦漂移，门禁失败。
#
# 顺序说明: Ccq 放在 Ui 之后 —— Ccq 只依赖 Ui 的语义输出与菜单 helper，
# 其余 core（Process/Profile/...）在 Ccq 之后加载；Load 自身由入口先行 source，
# 在加载循环中跳过，避免重复 source。

typeset -ga CCQ_CORE_ORDER=(
  Load
  Ui
  Ccq
  Process
  Profile
  Platform
  PackageManager
  Json
  Registry
  Bootstrap
  Update
)

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
  for core_file in "${CCQ_CORE_ORDER[@]}"; do
    # Load.zsh 已由入口先行 source；这里跳过以免重复 source。
    [ "${core_file}" = "Load" ] && continue
    ccq_source_file "${core_dir}/${core_file}.zsh" || {
      printf '无法加载 macOS core: %s\n' "${core_file}.zsh" >&2
      return 1
    }
  done
  ccq_set_output_mode "${CCQ_PARAM_OUTPUT_MODE}"
}
