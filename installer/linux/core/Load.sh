#!/usr/bin/env bash
# Load.sh - Linux core 加载顺序与加载函数的唯一声明处
# 功能: 以唯一一份有序声明 CCQ_CORE_ORDER 驱动 source 模式 core 加载。
# 说明: Install.sh 与 Download-Tui.sh 都只 source 本文件并调用 ccq_load_core。
#       Bash runtime 在 bootstrap 前不能依赖 node 读取 build.json，因此顺序只在此声明一次，
#       由 installer/contracts/Test-Contracts.ps1 断言与 build.json 的 Linux CoreFiles 一致。

CCQ_CORE_ORDER=(
  Load
  Ui
  Ccq
  Process
  Profile
  Platform
  PackageManager
  Registry
  Bootstrap
)

ccq_source_file() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || return 1
  source "${file_path}"
}

ccq_load_core() {
  if [ "${CCQ_BUILT_MODE:-0}" = "1" ] && declare -F ccq_set_output_mode >/dev/null 2>&1; then
    ccq_set_output_mode "${CCQ_PARAM_OUTPUT_MODE:-normal}"
    return 0
  fi

  local core_dir="${CCQ_LINUX_ROOT}/core"
  local core_file
  for core_file in "${CCQ_CORE_ORDER[@]}"; do
    # Load.sh 已由入口先行 source。
    [ "${core_file}" = "Load" ] && continue
    ccq_source_file "${core_dir}/${core_file}.sh" || {
      printf '无法加载 Linux core: %s\n' "${core_file}.sh" >&2
      return 1
    }
  done
  ccq_set_output_mode "${CCQ_PARAM_OUTPUT_MODE:-normal}"
}
