#!/usr/bin/env bash
# PackageManager.sh - Linux 系统包管理器封装（APT / DNF / Pacman）
# 功能: 按 linux-platforms.json 的 family→包管理器映射，以单条 sudo 安装 git。
# 说明: 不猜测其他修改路径；缺包管理器、缺 sudo、不可变系统或用户拒绝时进入 ManualRequired。
#       Pacman 只执行 -S --needed，不做 -Syu / -Sy（避免全系统升级与 partial upgrade）。

: "${CCQ_OSTREE_BOOTED_FILE:=/run/ostree-booted}"

ccq_pm_command() {
  case "${1:-}" in
    apt) printf 'apt-get' ;;
    dnf) printf 'dnf' ;;
    pacman) printf 'pacman' ;;
    *) return 1 ;;
  esac
}

ccq_pm_manual_hint() {
  case "${1:-}" in
    apt) printf 'sudo apt-get update && sudo apt-get install -y git' ;;
    dnf) printf 'sudo dnf install -y git' ;;
    pacman) printf 'sudo pacman -Syu git' ;;
    *) printf '请使用发行版包管理器手动安装 git' ;;
  esac
}

ccq_pm_install_git() {
  # 参数: $1 = 包管理器（apt|dnf|pacman）
  # 返回 0 = 包管理命令成功；非 0 时设置 CCQ_PM_STATUS（Failed|ManualRequired）与 CCQ_PM_ERROR。
  local pm="${1:-}" command_name hint choice
  CCQ_PM_STATUS="" CCQ_PM_ERROR=""
  hint="$(ccq_pm_manual_hint "${pm}")"

  if ! command_name="$(ccq_pm_command "${pm}")"; then
    CCQ_PM_STATUS=ManualRequired
    CCQ_PM_ERROR="未识别当前发行版的包管理器，请手动安装 git"
    return 1
  fi
  if ! ccq_command_exists "${command_name}"; then
    CCQ_PM_STATUS=ManualRequired
    CCQ_PM_ERROR="缺少预期的包管理器 ${command_name}，请手动安装 git"
    return 1
  fi
  if [ -e "${CCQ_OSTREE_BOOTED_FILE}" ]; then
    CCQ_PM_STATUS=ManualRequired
    CCQ_PM_ERROR="检测到不可变系统（ostree），不自动修改系统包；请按发行版方式手动安装 git"
    return 1
  fi
  if ! ccq_command_exists sudo; then
    CCQ_PM_STATUS=ManualRequired
    CCQ_PM_ERROR="sudo 不可用，无法安装系统包；请由管理员执行: ${hint}"
    return 1
  fi

  ccq_ui_warning "安装 Git 需要以 sudo 执行系统包管理命令：" >&2
  case "${pm}" in
    apt) ccq_ui_info "  sudo apt-get update" >&2; ccq_ui_info "  sudo apt-get install -y git" >&2 ;;
    dnf) ccq_ui_info "  sudo dnf install -y git" >&2 ;;
    pacman) ccq_ui_info "  sudo pacman -S --needed --noconfirm git" >&2 ;;
  esac
  choice="$(ccq_show_single_select_menu "是否继续通过 sudo 安装 Git？" 0 "是，继续" "否，稍后手动安装")" || choice=1
  if [ "${choice}" != "0" ]; then
    CCQ_PM_STATUS=ManualRequired
    CCQ_PM_ERROR="已取消自动安装；请手动执行: ${hint}"
    return 1
  fi

  case "${pm}" in
    apt)
      if ! ccq_sudo_run apt-get update || ! ccq_sudo_run apt-get install -y git; then
        CCQ_PM_STATUS=Failed
        CCQ_PM_ERROR="APT 安装 git 失败；请手动执行: ${hint}"
        return 1
      fi
      ;;
    dnf)
      if ! ccq_sudo_run dnf install -y git; then
        CCQ_PM_STATUS=Failed
        CCQ_PM_ERROR="DNF 安装 git 失败；请手动执行: ${hint}"
        return 1
      fi
      ;;
    pacman)
      if ! ccq_sudo_run pacman -S --needed --noconfirm git; then
        # 常见原因是本地包数据库过期；不替用户做全系统升级。
        CCQ_PM_STATUS=ManualRequired
        CCQ_PM_ERROR="pacman 安装 git 失败；请先完成系统升级后手动执行: ${hint}"
        return 1
      fi
      ;;
  esac
  return 0
}
