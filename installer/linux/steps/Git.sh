#!/usr/bin/env bash
# Git.sh - Linux Git 安装和基础配置
# 功能: 复用达标 git；否则按发行版家族的包管理器（单条 sudo）安装，安装后以 git --version 校验，
#       并应用与 Windows/macOS 一致的推荐 global config（不覆盖用户已有值）。

: "${CCQ_MIN_GIT_VERSION:=2.30.0}"

ccq_git_install_result() {
  printf 'Success=%s\nVersion=%s\nErrorMessage=%s\n' "${1:-false}" "${2:-}" "${3:-}"
}

ccq_git_version() {
  git --version 2>/dev/null | head -n 1 || true
}

ccq_git_version_ok() {
  ccq_command_exists git || return 1
  local version
  version="$(ccq_git_version)"
  version="${version#git version }"
  version="${version%% *}"
  [ -n "${version}" ] && ccq_linux_version_ge "${version}" "${CCQ_MIN_GIT_VERSION}"
}

ccq_git_config_value() {
  git config --global --get "$1" 2>/dev/null || true
}

ccq_git_has_required_config() {
  [ "$(ccq_git_config_value init.defaultBranch)" = "main" ] && [ "$(ccq_git_config_value core.quotepath)" = "false" ]
}

ccq_git_apply_config() {
  # 推荐配置键值对与 Windows/macOS 对齐；已有用户值不覆盖。
  local key value existing failed=0
  while read -r key value; do
    existing="$(ccq_git_config_value "${key}")"
    [ -n "${existing}" ] && continue
    git config --global "${key}" "${value}" 2>/dev/null || failed=1
  done <<'EOF'
init.defaultBranch main
core.quotepath false
i18n.commit.encoding utf-8
i18n.logoutputencoding utf-8
EOF
  [ "${failed}" -eq 0 ]
}

Test-GitInstalled() {
  if ccq_git_version_ok && ccq_git_has_required_config; then
    printf 'IsInstalled=true\nVersion=%s\nMessage=Git 已安装并完成推荐配置\n' "$(ccq_git_version)"
  else
    printf 'IsInstalled=false\nVersion=%s\nMessage=Git 未安装、版本过低或推荐配置未完成\n' "$(ccq_git_version)"
  fi
}

Install-Git() {
  if ! ccq_git_version_ok; then
    if ! ccq_pm_install_git "${CCQ_LINUX_PM:-}"; then
      printf 'Success=false\nStatus=%s\nErrorMessage=%s\n' "${CCQ_PM_STATUS:-Failed}" "${CCQ_PM_ERROR:-Git 安装失败}"
      return 1
    fi
    hash -r 2>/dev/null || true
    # postflight：包管理命令成功不等于可用，必须能运行 git --version。
    if ! ccq_git_version_ok; then
      ccq_git_install_result false "$(ccq_git_version)" "包管理器执行成功但 git --version 校验失败"
      return 1
    fi
  fi

  if ! ccq_git_apply_config; then
    ccq_git_install_result false "$(ccq_git_version)" "Git 推荐配置写入失败"
    return 1
  fi
  ccq_git_install_result true "$(ccq_git_version)" ""
}

Verify-Git() {
  if ccq_git_version_ok && ccq_git_has_required_config; then
    printf 'Success=true\nErrorMessage=\n'
    return 0
  fi
  printf 'Success=false\nErrorMessage=Git 安装或推荐配置验证失败\n'
  return 1
}
