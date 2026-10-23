#!/usr/bin/env bash
# Ccq.sh - ccq 可执行文件管理（Linux 平台唯一实现）
# 功能: 架构/路径检测、版本规范化、已安装探测、下载（gzip-first/raw fallback）、
#       chmod 0755 原子落盘、幂等 PATH 受管片段，以及 Release URL/版本与下载 handoff。
# 说明: 以 macOS core/Ccq.zsh 为蓝本移植，handoff 语义保持一致；差异仅限 Linux 判定、
#       linux-x64/linux-arm64 资产名与 profile 文件（见 core/Profile.sh）。

# ccq_get_architecture 的失败原因（仅 Linux x64/arm64 受支持）。
CCQ_PLATFORM_ERROR=""

ccq_get_architecture() {
  # 输出: "linux-x64" | "linux-arm64"；错误 OS 或未知架构明确失败，不回退猜测。
  CCQ_PLATFORM_ERROR=""
  local kernel arch
  kernel="$(uname -s 2>/dev/null || true)"
  if [ "${kernel}" != "Linux" ]; then
    CCQ_PLATFORM_ERROR="不支持的平台: ${kernel:-unknown}（Linux 安装器仅支持 Linux）"
    return 1
  fi

  arch="$(uname -m 2>/dev/null || true)"
  case "${arch}" in
    aarch64|arm64) printf 'linux-arm64' ;;
    x86_64|amd64) printf 'linux-x64' ;;
    *)
      CCQ_PLATFORM_ERROR="无法识别的处理器架构: ${arch:-unknown}"
      return 1
      ;;
  esac
}

ccq_get_executable_path() {
  printf '%s/.local/bin/ccq' "${HOME}"
}

ccq_normalize_version() {
  # 规范化 ccq 命令输出或 Release tag，供安装器比较版本。
  local version="${1:-}"
  version="${version#"${version%%[![:space:]]*}"}"
  version="${version%"${version##*[![:space:]]}"}"
  case "${version}" in
    ccq\ *) version="${version#ccq }" ;;
  esac
  case "${version}" in
    v[0-9]*) version="${version#v}" ;;
  esac
  printf '%s' "${version}"
}

ccq_test_executable_installed() {
  # 输出 JSON: {"isInstalled":0/1,"version":"x.y.z","path":"..."}
  local ccq_path is_installed=0 version=""
  ccq_path="$(ccq_get_executable_path)"

  if [ -f "${ccq_path}" ] && [ -x "${ccq_path}" ]; then
    # 只信任可快速响应 --version 的 ccq；旧/损坏可执行文件可能卡住，必须允许后续重新下载覆盖。
    local version_file version_pid waited=0
    version_file="$(mktemp "${TMPDIR:-/tmp}/ccq_version.XXXXXX" 2>/dev/null || printf '%s/.ccq-version-%s' "${TMPDIR:-/tmp}" "$$")"
    "${ccq_path}" --version >"${version_file}" 2>/dev/null &
    version_pid="$!"
    while kill -0 "${version_pid}" >/dev/null 2>&1; do
      if [ "${waited}" -ge 3 ]; then
        kill "${version_pid}" >/dev/null 2>&1 || true
        wait "${version_pid}" 2>/dev/null || true
        break
      fi
      sleep 1
      waited=$((waited + 1))
    done
    if wait "${version_pid}" 2>/dev/null; then
      version="$(head -n 1 "${version_file}" 2>/dev/null || true)"
      if [ -n "${version}" ]; then
        is_installed=1
        version="$(ccq_normalize_version "${version}")"
      fi
    fi
    rm -f "${version_file}" 2>/dev/null || true
  fi

  printf '{"isInstalled":%s,"version":"%s","path":"%s"}\n' "${is_installed}" "${version}" "${ccq_path}"
}

CCQ_DOWNLOAD_ERROR=""

ccq_download_file() {
  # 下载单个 URL 到指定临时文件。每次调用都是独立传输。
  local download_url="${1:-}" output_path="${2:-}"
  CCQ_DOWNLOAD_ERROR=""
  if [ -z "${download_url}" ] || [ -z "${output_path}" ]; then
    CCQ_DOWNLOAD_ERROR="下载 URL 或输出路径为空"
    return 1
  fi

  rm -f "${output_path}" 2>/dev/null || true
  if command -v curl >/dev/null 2>&1; then
    if ! curl -fL --progress-bar --connect-timeout 20 --max-time 600 -o "${output_path}" "${download_url}"; then
      rm -f "${output_path}" 2>/dev/null || true
      CCQ_DOWNLOAD_ERROR="curl 下载失败"
      return 1
    fi
  elif command -v wget >/dev/null 2>&1; then
    if ! wget --show-progress --progress=bar:force --timeout=20 --tries=3 -O "${output_path}" "${download_url}"; then
      rm -f "${output_path}" 2>/dev/null || true
      CCQ_DOWNLOAD_ERROR="wget 下载失败"
      return 1
    fi
  else
    CCQ_DOWNLOAD_ERROR="curl 和 wget 均不可用"
    return 1
  fi

  if [ ! -f "${output_path}" ]; then
    CCQ_DOWNLOAD_ERROR="下载成功但输出文件不存在"
    return 1
  fi
  return 0
}

ccq_install_executable() {
  # 下载并安装 ccq 可执行文件到 ~/.local/bin/ccq，并确保该目录在 PATH
  # 参数: $1 = 下载 URL；返回: 0 = 成功; 1 = 失败（现有 ccq 保持不变）
  local download_url="${1:-}"
  [ -z "${download_url}" ] && { printf 'Error: download_url required\n' >&2; return 1; }

  local ccq_path ccq_bin_dir tmp_path gzip_tmp_path gzip_url
  local gzip_error="" gzip_ready=0
  ccq_path="$(ccq_get_executable_path)"
  ccq_bin_dir="$(dirname "${ccq_path}")"
  tmp_path="${ccq_path}.download.$$"
  gzip_tmp_path="${tmp_path}.gz"
  gzip_url="${download_url}.gz"

  # 1. 创建目标目录
  if [ ! -d "${ccq_bin_dir}" ]; then
    mkdir -p "${ccq_bin_dir}" || { printf 'Error: 无法创建目录 %s\n' "${ccq_bin_dir}" >&2; return 1; }
    ccq_ui_info "创建 ccq 目录: ${ccq_bin_dir}"
  fi

  # 2. 优先传输 gzip 资产；不可用或损坏时重新开始一次 raw 下载。
  ccq_ui_info "正在下载 ccq 可执行文件..."
  ccq_ui_dim "  URL: ${gzip_url}"

  rm -f "${tmp_path}" "${gzip_tmp_path}" 2>/dev/null || true
  if ccq_download_file "${gzip_url}" "${gzip_tmp_path}"; then
    if ! command -v gzip >/dev/null 2>&1; then
      gzip_error="系统 gzip 命令不可用"
    elif gzip -dc -- "${gzip_tmp_path}" >"${tmp_path}" && [ -s "${tmp_path}" ]; then
      gzip_ready=1
      rm -f "${gzip_tmp_path}" 2>/dev/null || true
    elif [ -f "${tmp_path}" ] && [ ! -s "${tmp_path}" ]; then
      gzip_error="gzip 解压结果为空"
    else
      gzip_error="gzip 解压失败或数据损坏"
    fi
  else
    gzip_error="gzip 下载失败: ${CCQ_DOWNLOAD_ERROR:-未知错误}"
  fi

  if [ "${gzip_ready}" -ne 1 ]; then
    rm -f "${tmp_path}" "${gzip_tmp_path}" 2>/dev/null || true
    [ -n "${gzip_error}" ] || gzip_error="gzip 传输未生成可用文件"
    ccq_ui_warning "gzip 传输失败（${gzip_error}），正在改用 raw 资产..."
    ccq_ui_dim "  URL: ${download_url}"

    if ! ccq_download_file "${download_url}" "${tmp_path}"; then
      local raw_error="${CCQ_DOWNLOAD_ERROR:-未知错误}"
      rm -f "${tmp_path}" "${gzip_tmp_path}" 2>/dev/null || true
      printf 'Error: raw 下载失败: %s；gzip 失败上下文: %s\n' "${raw_error}" "${gzip_error}" >&2
      return 1
    fi
  fi

  # 3. 无论来源为何，只有完整且非空的 raw temp 才能进入最终落盘流程。
  if [ ! -s "${tmp_path}" ]; then
    rm -f "${tmp_path}" "${gzip_tmp_path}" 2>/dev/null || true
    if [ "${gzip_ready}" -eq 1 ]; then
      printf 'Error: gzip 解压后的 raw 文件为空或不存在\n' >&2
    else
      printf 'Error: raw 下载失败: 下载的文件为空或不存在；gzip 失败上下文: %s\n' "${gzip_error}" >&2
    fi
    return 1
  fi

  local file_size
  file_size="$(wc -c <"${tmp_path}" | tr -d '[:space:]')"

  # 4. 设置可执行权限并原子替换（同目录 rename）
  rm -f "${gzip_tmp_path}" 2>/dev/null || true
  chmod 0755 "${tmp_path}" || { rm -f "${tmp_path}" 2>/dev/null || true; printf 'Error: 无法设置可执行权限\n' >&2; return 1; }
  mv -f "${tmp_path}" "${ccq_path}" || { rm -f "${tmp_path}" 2>/dev/null || true; printf 'Error: 无法安装 ccq 可执行文件\n' >&2; return 1; }

  ccq_ui_success "✓ ccq 可执行文件已下载到: ${ccq_path}"
  ccq_ui_dim "  文件大小: $((file_size / 1048576)).$(printf '%02d' $((file_size * 100 / 1048576 % 100))) MB"

  # 5. 幂等写入 ~/.local/bin PATH 受管片段（失败只告警，不回滚已落盘的 ccq）
  ccq_profile_ensure_local_bin || true
  case ":${PATH}:" in
    *":${ccq_bin_dir}:"*) ;;
    *) ccq_ui_warning "⚠ 请开启新终端后使用 ccq 命令（当前会话 PATH 尚未刷新）" ;;
  esac

  return 0
}

# ─── CCQ Release 解析与下载 handoff ──────────────────────────────────────────

# ccq_confirm_executable_download 接收入口模式参数：
#   install   = 完整安装入口，首次未安装时保留「是否现在下载」确认
#   dedicated = 专用下载入口，用户主动运行即视为已授权，跳过首次确认菜单
# 两种模式都保留同版本跳过、版本不一致默认保留、目标版本未知时保留现有可执行文件。
# 返回值: 0 = 已安装/同版本/按既定策略有意保留或跳过；1 = 确实尝试下载但未得到可用的 ccq。
ccq_get_release_download_base_url() {
  # 默认 latest stable，保留调用方显式 tag/URL 覆盖。
  if [ -n "${CCQ_RELEASE_DOWNLOAD_BASE_URL:-}" ]; then
    printf '%s' "${CCQ_RELEASE_DOWNLOAD_BASE_URL%/}"
    return 0
  fi

  # 仅调用方显式提供 v* tag 时选择固定 Release；人工 builder 不注入 tag。
  local tag="${CCQ_RELEASE_TAG:-}"
  case "${tag}" in
    v*)
      printf 'https://github.com/MrNine-666/claude-code-quickstart/releases/download/%s' "${tag}"
      return 0
      ;;
  esac

  printf 'https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download'
}

ccq_get_release_target_version() {
  # 从 Release tag 提取可与 ccq --version 比较的目标版本。
  local tag="${CCQ_RELEASE_TAG:-}" version=""
  case "${tag}" in
    v*) version="$(ccq_normalize_version "${tag}")" ;;
    *) return 0 ;;
  esac
  case "${version}" in
    [0-9]*.[0-9]*.[0-9]*) printf '%s' "${version}" ;;
  esac
}

ccq_confirm_executable_download() {
  # 参数: $1 = 模式（install | dedicated，默认 install）
  local mode="${1:-install}"

  ccq_ui_primary "ccq 管理工具安装"
  printf '\n'
  ccq_ui_info "ccq 是 Claude Code Quickstart 的管理控制台，提供以下功能："
  ccq_ui_info "  • 供应商管理（Provider 配置）"
  ccq_ui_info "  • MCP Server 管理"
  ccq_ui_info "  • Skills 管理"
  ccq_ui_info "  • 提示词配置"
  ccq_ui_info "  • 配置文件管理"
  ccq_ui_info "  • 工具管理（安装/更新 Claude Code、Codex、Pi、CodeGraph、OpenSpec 等）"
  ccq_ui_info "  • 扩展管理（安装/更新/卸载 Pi package 扩展）"
  printf '\n'

  # 1. 已安装时先比较当前版本与安装器 Release 版本。
  local installed_json installed_status installed_path installed_version target_version current_version decision
  installed_json="$(ccq_test_executable_installed)"
  installed_status="$(printf '%s' "${installed_json}" | grep -o '"isInstalled":[^,}]*' | cut -d: -f2)"

  if [ "${installed_status}" = "1" ] || [ "${installed_status}" = "true" ]; then
    installed_path="$(printf '%s' "${installed_json}" | grep -o '"path":"[^"]*"' | cut -d'"' -f4)"
    installed_version="$(printf '%s' "${installed_json}" | grep -o '"version":"[^"]*"' | cut -d'"' -f4)"
    current_version="$(ccq_normalize_version "${installed_version}")"
    target_version="$(ccq_get_release_target_version)"

    ccq_ui_success "✓ ccq 可执行文件已安装: ${installed_path}"
    ccq_ui_info "  当前版本: ${current_version}"

    if [ -z "${target_version}" ]; then
      ccq_ui_warning "无法确定安装器目标版本，已保留现有 ccq"
      ccq_ui_dim "  如需更新，请运行 ccq update"
      return 0
    fi

    ccq_ui_info "  目标版本: ${target_version}"
    if [ "${current_version}" = "${target_version}" ]; then
      ccq_ui_success "✓ 当前版本与目标版本一致，无需覆盖"
      return 0
    fi

    ccq_ui_warning "检测到 ccq 版本不一致"
    decision="$(ccq_show_single_select_menu "是否覆盖现有文件？" 1 "是，覆盖为 ${target_version}" "否，保留当前版本 ${current_version}")" || decision=1
    if [ "${decision}" != "0" ]; then
      ccq_ui_info "已保留当前 ccq 版本: ${current_version}"
      return 0
    fi

    ccq_ui_warning "将使用目标版本 ${target_version} 覆盖当前版本 ${current_version}"
  elif [ "${mode}" = "dedicated" ]; then
    ccq_ui_info "用户主动运行 CCQ 专用下载入口，视为已授权下载 ccq 可执行文件"
  else
    decision="$(ccq_show_single_select_menu "是否现在下载 ccq 可执行文件到 ~/.local/bin？（拒绝则跳过，可稍后手动安装）" 0 "是，下载 ccq" "否，稍后手动安装")" || decision=1
    if [ "${decision}" != "0" ]; then
      printf '\n'
      ccq_ui_info "已跳过 ccq 可执行文件下载"
      ccq_ui_dim "  如需稍后安装，请访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
      printf '\n'
      ccq_ui_primary "后续安装 Claude Code / Codex / Pi："
      ccq_ui_info "  稍后安装 ccq 后运行 ccq，进入「工具管理」按需安装 Claude Code、Codex 或 Pi"
      ccq_ui_info "  API Key、provider/profile 可在「供应商」菜单中可视化配置；Pi 官方登录请在 Pi 中执行 /login"
      return 0
    fi
  fi

  printf '\n'
  ccq_ui_info "正在准备下载 ccq 可执行文件..."

  # 2. 检测平台架构（错误 OS 或未知架构明确失败，不回退猜测）
  local arch
  if ! arch="$(ccq_get_architecture)"; then
    ccq_ui_danger "${CCQ_PLATFORM_ERROR:-无法识别当前平台架构}"
    return 1
  fi
  ccq_ui_info "检测到平台架构: ${arch}"

  # 3. 构建下载 URL
  local base_url exe_name download_url
  base_url="$(ccq_get_release_download_base_url)"
  exe_name="ccq-${arch}"
  download_url="${base_url}/${exe_name}"

  ccq_ui_dim "  下载 URL: ${download_url}"

  # 4. 执行下载与安装
  if ccq_install_executable "${download_url}"; then
    printf '\n'
    ccq_ui_success " ccq 可执行文件安装成功！"
    printf '\n'
    ccq_ui_primary "下一步："
    ccq_ui_info "  1. 打开一个新的终端窗口"
    ccq_ui_info "  2. 输入 ccq 进入管理控制台"
    ccq_ui_info "  3. 进入「工具管理」安装 Claude Code、Codex 或 Pi，再到「供应商」配置 API Key、provider/profile"
    ccq_ui_info "  4. 使用「扩展管理」维护 Pi package 扩展"
    printf '\n'
    ccq_ui_dim "（当前会话 PATH 尚未刷新，必须开启新终端 ccq 命令才生效）"
  else
    printf '\n'
    ccq_ui_warning "ccq 可执行文件下载失败"
    ccq_ui_info "您可以稍后手动下载："
    ccq_ui_info "  1. 访问: https://github.com/MrNine-666/claude-code-quickstart/releases"
    ccq_ui_info "  2. 下载对应平台的可执行文件（${exe_name}）"
    ccq_ui_info "  3. 放置到 ~/.local/bin 并设置可执行权限（chmod +x）"
    printf '\n'
    ccq_ui_primary "后续安装 Claude Code / Codex / Pi："
    ccq_ui_info "  等待 ccq 安装完成后运行 ccq，进入「工具管理」按需安装 Claude Code、Codex 或 Pi"
    ccq_ui_info "  API Key、provider/profile 可在「供应商」菜单中可视化配置；Pi 官方登录请在 Pi 中执行 /login"
    return 1
  fi

  return 0
}
