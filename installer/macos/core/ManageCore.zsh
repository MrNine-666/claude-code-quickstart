#!/usr/bin/env zsh
# ManageCore.zsh - Manage JS 单文件 bundle 缓存调用 wrapper（轻量 Node.js wrapper）
# 版本: 1.0.0（Phase 10：方案 3 架构 — esbuild 单文件 bundle + 固定目录缓存）
# 作者: 哈雷酱
# 功能: 检测 Node.js → 解析 manage.js（源码优先 / 缓存复用 / 过期 curl）→ node 调用（TTY 继承）
# 依赖: Ui.zsh（须在本模块之前加载）
#
# 缓存策略（HC-CACHE-TMPDIR）：
#   - 源码模式（CCQ_INSTALLER_ROOT/CCQ_MACOS_ROOT 解析到 contracts/scripts/manage.js）：直接运行源码，离线可用
#   - Release 模式：缓存 ${TMPDIR:-/tmp}/.ccq/manage.js（1 小时 TTL），过期 curl /latest/download/manage.js

if [ -n "${CCQ_MANAGE_CORE_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_MANAGE_CORE_ZSH_LOADED=1

# ============================================================================
# 配置常量
# ============================================================================

# manage.js 单文件 bundle 的固定 Release 下载地址（HC-ZERO-CACHE：无版本号 / 无内容哈希）
CCQ_MANAGE_BUNDLE_URL="https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download/manage.js"

# 缓存有效期（秒）：1 小时
CCQ_MANAGE_CACHE_TTL_SECONDS=3600

# 解析结果（由 ccq_manage_core_resolve_script 写入，避免 UI 输出污染 $() 捕获）
CCQ_MANAGE_RESOLVED_PATH=""

# ============================================================================
# 路径解析与调用
# ============================================================================

# 获取 manage.js 固定缓存路径
ccq_manage_core_cache_path() {
  printf '%s\n' "${TMPDIR:-/tmp}/.ccq/manage.js"
}

# 源码模式探测：echo 源码 manage.js 路径（不可用时 echo 空，仅 printf 不调 UI，可安全 $() 捕获）
ccq_manage_core_source_script() {
  local contracts_root=""
  if [ -n "${CCQ_INSTALLER_ROOT:-}" ]; then
    contracts_root="${CCQ_INSTALLER_ROOT}/contracts"
  elif [ -n "${CCQ_MACOS_ROOT:-}" ]; then
    contracts_root="$(dirname "${CCQ_MACOS_ROOT}")/contracts"
  fi
  if [ -n "${contracts_root}" ] && [ -f "${contracts_root}/scripts/manage.js" ]; then
    printf '%s\n' "${contracts_root}/scripts/manage.js"
  fi
}

# 解析要执行的 manage.js 路径：源码优先 → 缓存复用 → 过期下载
# 结果写入 CCQ_MANAGE_RESOLVED_PATH；成功返回 0，彻底失败返回 1
ccq_manage_core_resolve_script() {
  CCQ_MANAGE_RESOLVED_PATH=""

  # 1. 源码模式优先（离线可用，require 子模块直接命中同目录）
  local source_script
  source_script="$(ccq_manage_core_source_script)"
  if [ -n "${source_script}" ]; then
    CCQ_MANAGE_RESOLVED_PATH="${source_script}"
    return 0
  fi

  # 2. Release 模式：缓存检查（1 小时 TTL）
  local cache_path cache_dir now mtime age
  cache_path="$(ccq_manage_core_cache_path)"
  if [ -f "${cache_path}" ]; then
    now=$(date +%s)
    mtime=$(stat -f %m "${cache_path}" 2>/dev/null || stat -c %Y "${cache_path}" 2>/dev/null)
    if [ -n "${mtime}" ]; then
      age=$((now - mtime))
      if [ "${age}" -lt "${CCQ_MANAGE_CACHE_TTL_SECONDS}" ]; then
        CCQ_MANAGE_RESOLVED_PATH="${cache_path}"
        return 0
      fi
    fi
  fi

  # 3. 缓存缺失或过期：下载最新 bundle
  cache_dir="$(dirname "${cache_path}")"
  mkdir -p "${cache_dir}"
  if curl -fsSL "${CCQ_MANAGE_BUNDLE_URL}" -o "${cache_path}" 2>/dev/null; then
    CCQ_MANAGE_RESOLVED_PATH="${cache_path}"
    return 0
  fi

  # 下载失败：存在旧缓存则降级复用（可能非最新），否则报错
  if [ -f "${cache_path}" ]; then
    ccq_ui_warning "manage.js 下载失败，复用已有缓存（可能非最新）"
    CCQ_MANAGE_RESOLVED_PATH="${cache_path}"
    return 0
  fi
  ccq_ui_danger "manage.js 下载失败且无缓存可用"
  return 1
}

# 管理面板入口（对齐 Windows Show-ManagePanel）
ccq_manage_core_show_panel() {
  # 1. 检查 Node.js
  if ! command -v node >/dev/null 2>&1; then
    ccq_ui_danger "Node.js 未安装或不在 PATH 中"
    ccq_ui_info "请先安装 Node.js LTS：https://nodejs.org/"
    return 1
  fi

  # 1b. 检查 Node.js 版本（<20 警告，对齐 wrapper spec「Node.js version too old」场景）
  local node_version node_major
  node_version="$(node --version 2>/dev/null)"
  node_major="${node_version#v}"
  node_major="${node_major%%.*}"
  if [ -n "${node_major}" ] && [ "${node_major}" -lt 20 ] 2>/dev/null; then
    ccq_ui_warning "检测到 Node.js 版本 ${node_version} (<20)，部分功能可能不可用，请通过 nvm 升级"
  fi

  # 2. 解析 manage.js（源码 / 缓存 / 下载）
  ccq_manage_core_resolve_script || return 1
  local manage_path exit_code
  manage_path="${CCQ_MANAGE_RESOLVED_PATH}"
  [ -n "${manage_path}" ] || return 1

  # 3. 调用 manage.js（TTY 继承，交互式菜单）
  node "${manage_path}"
  exit_code=$?
  if [ "${exit_code}" -ne 0 ]; then
    ccq_ui_warning "管理面板退出码: ${exit_code}"
  fi
  return "${exit_code}"
}
