#!/usr/bin/env bash
# Registry.sh - Linux 步骤注册表
# 功能: Basic 分组的步骤字段、步骤文件清单与执行顺序。
# 说明: Linux 安装链的目的就是装 Node.js，因此不能像 macOS 那样用 node 读取 steps.json；
#       本文件是 steps.json 的 Bash 快照，StepId/Order/函数名/LinuxStepFile 由
#       installer/contracts/Test-Contracts.ps1 断言与 steps.json 一致。
# 注意: core 在 ccq_source_file 函数内 source，顶层不得用 declare/local（会变成局部变量）。

CCQ_REGISTRY_STEP_IDS=(NodeJS Git)

ccq_get_group_step_ids() {
  case "${1:-}" in
    Basic) printf '%s\n' "${CCQ_REGISTRY_STEP_IDS[@]}" ;;
    *) return 1 ;;
  esac
}

ccq_get_group_field() {
  case "${1:-}:${2:-}" in
    Basic:Label) printf '基础环境' ;;
    Basic:Description) printf 'ccq 运行所需基础环境' ;;
    Basic:InstallMode) printf 'OneClickOnly' ;;
    *) return 1 ;;
  esac
}

ccq_get_step_field() {
  local step_id="${1:-}" field="${2:-}"
  case "${step_id}:${field}" in
    NodeJS:StepName) printf 'Node.js' ;;
    NodeJS:Description) printf '现有 node/npm 达标则跳过；否则在当前 nvm/fnm 内安装 LTS，无 provider 时通过 nvm 官方脚本兜底' ;;
    NodeJS:Order) printf '10' ;;
    Git:StepName) printf 'Git' ;;
    Git:Description) printf '通过发行版包管理器（APT / DNF / Pacman，单条 sudo）安装 Git' ;;
    Git:Order) printf '20' ;;
    NodeJS:LinuxStepFile|Git:LinuxStepFile) printf 'linux/steps/%s.sh' "${step_id}" ;;
    NodeJS:TestFunction|Git:TestFunction) printf 'Test-%sInstalled' "${step_id}" ;;
    NodeJS:InstallFunction|Git:InstallFunction) printf 'Install-%s' "${step_id}" ;;
    NodeJS:VerifyFunction|Git:VerifyFunction) printf 'Verify-%s' "${step_id}" ;;
    NodeJS:SkipIfInstalled|Git:SkipIfInstalled) printf 'true' ;;
    NodeJS:IsOptional|Git:IsOptional) printf 'false' ;;
    NodeJS:Dependencies|Git:Dependencies) ;;
    *) return 1 ;;
  esac
}

ccq_get_step_files() {
  local step_id
  for step_id in "${CCQ_REGISTRY_STEP_IDS[@]}"; do
    ccq_get_step_field "${step_id}" LinuxStepFile
    printf '\n'
  done
}

ccq_get_execution_order() {
  # Basic 步骤无依赖，按 Order 排序即可。
  local step_id
  for step_id in "$@"; do
    printf '%s %s\n' "$(ccq_get_step_field "${step_id}" Order || printf 999)" "${step_id}"
  done | sort -n | cut -d' ' -f2
}
