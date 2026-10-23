#!/usr/bin/env bash
# Platform.sh - Linux 平台识别
# 功能: /etc/os-release 解析与发行版分类、WSL/libc/架构检测、root 与 Bash 版本前置检查
# 说明: 判定规则与 installer/contracts/linux-platforms.json 等价（bootstrap 前不能依赖 node/jq），
#       漂移由 Test-LinuxInstaller.sh 对照 linux-platform-expectations.mjs 展开的期望表检测。
#       CCQ_OS_RELEASE_FILE / CCQ_PROC_VERSION_FILE 可覆盖探测路径；uname / id / ldd / getconf
#       经 PATH 解析，测试用 fake 命令替换。

CCQ_LAST_PLATFORM_ERROR=""

ccq_is_linux() {
  [ "$(uname -s 2>/dev/null)" = "Linux" ]
}

ccq_linux_bash_ok() {
  [ "${BASH_VERSINFO[0]:-0}" -ge 4 ]
}

ccq_linux_is_root() {
  [ "$(id -u 2>/dev/null)" = "0" ]
}

# ─── os-release ──────────────────────────────────────────────────────────────

ccq_linux_unquote_os_release_value() {
  # os-release 值: 双引号（支持 \" \\ \$ \` 转义）、单引号或不含空白/引号的裸值。
  local value="$1" inner
  case "${value}" in
    \"*\")
      inner="${value:1:${#value}-2}"
      inner="${inner//\\\"/\"}"
      inner="${inner//\\\$/\$}"
      inner="${inner//\\\`/\`}"
      inner="${inner//\\\\/\\}"
      printf '%s' "${inner}"
      ;;
    \'*\')
      printf '%s' "${value:1:${#value}-2}"
      ;;
    *[[:space:]\"\'\`\$\\]*)
      return 1
      ;;
    *)
      printf '%s' "${value}"
      ;;
  esac
}

ccq_linux_parse_os_release() {
  # 逐行解析 key=value，不 eval、不 source。成功设置 CCQ_OS_ID/VERSION_ID/NAME/ID_LIKE/PRETTY_NAME。
  # 返回: 0 = 成功; 1 = 文件缺失; 2 = 畸形
  local file="${CCQ_OS_RELEASE_FILE:-}"
  local line key raw value line_number=0
  CCQ_OS_ID="" CCQ_OS_VERSION_ID="" CCQ_OS_NAME="" CCQ_OS_ID_LIKE="" CCQ_OS_PRETTY_NAME=""

  if [ -z "${file}" ]; then
    if [ -f /etc/os-release ]; then file=/etc/os-release; else file=/usr/lib/os-release; fi
  fi
  if [ ! -f "${file}" ] || [ ! -r "${file}" ]; then
    CCQ_LAST_PLATFORM_ERROR="无法读取 ${file}，无法识别 Linux 发行版"
    return 1
  fi

  while IFS= read -r line || [ -n "${line}" ]; do
    line_number=$((line_number + 1))
    line="${line%$'\r'}"
    line="${line#"${line%%[![:space:]]*}"}"
    case "${line}" in ''|'#'*) continue ;; esac
    if [[ ! "${line}" =~ ^([A-Za-z_][A-Za-z0-9_]*)=(.*)$ ]]; then
      CCQ_LAST_PLATFORM_ERROR="${file} 第 ${line_number} 行格式无效"
      return 2
    fi
    key="${BASH_REMATCH[1]}"
    raw="${BASH_REMATCH[2]}"
    if ! value="$(ccq_linux_unquote_os_release_value "${raw}")"; then
      CCQ_LAST_PLATFORM_ERROR="${file} 第 ${line_number} 行取值无效"
      return 2
    fi
    case "${key}" in
      ID) CCQ_OS_ID="${value,,}" ;;
      VERSION_ID) CCQ_OS_VERSION_ID="${value}" ;;
      NAME) CCQ_OS_NAME="${value}" ;;
      ID_LIKE) CCQ_OS_ID_LIKE="${value,,}" ;;
      PRETTY_NAME) CCQ_OS_PRETTY_NAME="${value}" ;;
    esac
  done <"${file}"

  if [ -z "${CCQ_OS_ID}" ]; then
    CCQ_LAST_PLATFORM_ERROR="${file} 缺少 ID 字段"
    return 2
  fi
  return 0
}

ccq_linux_version_ge() {
  # 数字点分版本比较（最多 3 段）；非数字段按 0 处理。
  local -a actual required
  local i a r
  IFS=. read -r -a actual <<<"${1:-0}"
  IFS=. read -r -a required <<<"${2:-0}"
  for i in 0 1 2; do
    a="${actual[i]:-0}"; r="${required[i]:-0}"
    [[ "${a}" =~ ^[0-9]+$ ]] || a=0
    [[ "${r}" =~ ^[0-9]+$ ]] || r=0
    if ((10#${a} > 10#${r})); then return 0; fi
    if ((10#${a} < 10#${r})); then return 1; fi
  done
  return 0
}

ccq_linux_family_package_manager() {
  case "${1:-}" in
    debian) printf 'apt' ;;
    fedora) printf 'dnf' ;;
    arch) printf 'pacman' ;;
    *) return 1 ;;
  esac
}

ccq_linux_classify_versioned() {
  # 参数: family official_version min_version
  local family="$1" official="$2" min="$3" version="${CCQ_OS_VERSION_ID}"
  CCQ_LINUX_FAMILY="${family}"
  if [ "${version}" = "${official}" ]; then
    CCQ_LINUX_CLASS=official
  elif [ -z "${version}" ]; then
    CCQ_LINUX_CLASS=best-effort
    CCQ_LINUX_REASON="未提供 VERSION_ID，非 CI 验证基线"
  elif ccq_linux_version_ge "${version}" "${min}"; then
    CCQ_LINUX_CLASS=best-effort
    CCQ_LINUX_REASON="版本 ${version} 不是 CI 验证基线 ${official}"
  else
    CCQ_LINUX_CLASS=unsupported
    CCQ_LINUX_FAMILY=""
    CCQ_LINUX_REASON="版本 ${version} 低于最低要求 ${min}"
  fi
}

ccq_linux_classify() {
  # 依据已解析的 os-release 分类，设置 CCQ_LINUX_CLASS（official|best-effort|unsupported）、
  # CCQ_LINUX_FAMILY、CCQ_LINUX_PM、CCQ_LINUX_REASON。已知 ID 只按自身规则判定，不回退 ID_LIKE。
  local token
  CCQ_LINUX_CLASS=unsupported CCQ_LINUX_FAMILY="" CCQ_LINUX_PM="" CCQ_LINUX_REASON=""

  case "${CCQ_OS_ID}" in
    ubuntu) ccq_linux_classify_versioned debian 24.04 22.04 ;;
    debian) ccq_linux_classify_versioned debian 13 12 ;;
    fedora) ccq_linux_classify_versioned fedora 44 42 ;;
    centos)
      # 仅 CentOS Stream 9/10；CentOS Linux 7/8 已停止维护。
      if [[ "${CCQ_OS_NAME}" != *Stream* ]]; then
        CCQ_LINUX_REASON="仅支持 CentOS Stream 9/10，不支持 ${CCQ_OS_NAME:-CentOS} ${CCQ_OS_VERSION_ID}"
      else
        case "${CCQ_OS_VERSION_ID}" in
          10) CCQ_LINUX_CLASS=official CCQ_LINUX_FAMILY=fedora ;;
          9) CCQ_LINUX_CLASS=best-effort CCQ_LINUX_FAMILY=fedora CCQ_LINUX_REASON="CentOS Stream 9 不是 CI 验证基线 10" ;;
          *) CCQ_LINUX_REASON="仅支持 CentOS Stream 9/10，当前版本 ${CCQ_OS_VERSION_ID:-unknown}" ;;
        esac
      fi
      ;;
    arch) CCQ_LINUX_CLASS=official CCQ_LINUX_FAMILY=arch ;;
    *)
      for token in ${CCQ_OS_ID_LIKE}; do
        case "${token}" in
          debian|ubuntu) CCQ_LINUX_FAMILY=debian ;;
          fedora|rhel|centos) CCQ_LINUX_FAMILY=fedora ;;
          arch) CCQ_LINUX_FAMILY=arch ;;
          *) continue ;;
        esac
        CCQ_LINUX_CLASS=best-effort
        CCQ_LINUX_REASON="${CCQ_OS_NAME:-${CCQ_OS_ID}} 按 ID_LIKE=${token} 进入 ${CCQ_LINUX_FAMILY} 家族路径，未经验证"
        break
      done
      [ "${CCQ_LINUX_CLASS}" = "unsupported" ] && CCQ_LINUX_REASON="无法识别的发行版: ${CCQ_OS_NAME:-${CCQ_OS_ID}}"
      ;;
  esac

  if [ -n "${CCQ_LINUX_FAMILY}" ]; then
    CCQ_LINUX_PM="$(ccq_linux_family_package_manager "${CCQ_LINUX_FAMILY}")"
  fi
  [ "${CCQ_LINUX_CLASS}" != "unsupported" ]
}

ccq_linux_detect_distribution() {
  # 解析 + 分类；缺失/畸形 os-release 一律 unsupported，不猜包管理器。
  CCQ_LINUX_CLASS=unsupported CCQ_LINUX_FAMILY="" CCQ_LINUX_PM="" CCQ_LINUX_REASON=""
  if ! ccq_linux_parse_os_release; then
    CCQ_LINUX_REASON="${CCQ_LAST_PLATFORM_ERROR}"
    return 1
  fi
  ccq_linux_classify
}

# ─── WSL / libc / 架构 ───────────────────────────────────────────────────────

ccq_linux_wsl_kind() {
  # 输出 none | wsl1 | wsl2。WSL2 内核含 microsoft-standard 或 WSL2 标记；WSL1 只有 Microsoft。
  local proc_version
  proc_version="$(cat "${CCQ_PROC_VERSION_FILE:-/proc/version}" 2>/dev/null || true)"
  case "${proc_version,,}" in
    *microsoft-standard*|*wsl2*) printf 'wsl2' ;;
    *microsoft*) printf 'wsl1' ;;
    *) printf 'none' ;;
  esac
}

ccq_linux_libc() {
  # 输出 glibc | musl | unknown
  local ldd_output
  ldd_output="$(ldd --version 2>&1 || true)"
  case "${ldd_output,,}" in
    *musl*) printf 'musl'; return 0 ;;
  esac
  if getconf GNU_LIBC_VERSION >/dev/null 2>&1; then
    printf 'glibc'; return 0
  fi
  case "${ldd_output,,}" in
    *glibc*|*"gnu libc"*|*"gnu c library"*) printf 'glibc'; return 0 ;;
  esac
  if compgen -G '/lib/ld-musl-*' >/dev/null 2>&1; then
    printf 'musl'; return 0
  fi
  printf 'unknown'
}

ccq_linux_arch() {
  # uname -m 别名 → x64 | arm64（与 linux-platforms.json Architectures 一致）
  local machine
  machine="$(uname -m 2>/dev/null || true)"
  case "${machine}" in
    x86_64|amd64) printf 'x64' ;;
    aarch64|arm64) printf 'arm64' ;;
    *)
      CCQ_LAST_PLATFORM_ERROR="不支持的处理器架构: ${machine:-unknown}（仅支持 x86_64 / aarch64）"
      return 1
      ;;
  esac
}

ccq_linux_check_binary_runtime() {
  # ccq 二进制可运行前提：Linux 内核、非 WSL1、glibc、x64/arm64。任何下载/修改之前调用。
  local kernel wsl libc
  CCQ_LAST_PLATFORM_ERROR=""
  kernel="$(uname -s 2>/dev/null || true)"
  if [ "${kernel}" != "Linux" ]; then
    CCQ_LAST_PLATFORM_ERROR="不支持的平台: ${kernel:-unknown}（Linux 安装器仅支持 Linux）"
    return 1
  fi
  wsl="$(ccq_linux_wsl_kind)"
  if [ "${wsl}" = "wsl1" ]; then
    CCQ_LAST_PLATFORM_ERROR="不支持 WSL1；请执行 wsl --set-version <发行版> 2 升级到 WSL2，或在 Windows 中使用 install.ps1"
    return 1
  fi
  libc="$(ccq_linux_libc)"
  case "${libc}" in
    glibc) ;;
    musl)
      CCQ_LAST_PLATFORM_ERROR="不支持 musl libc（如 Alpine）；ccq 仅提供 glibc 版本"
      return 1
      ;;
    *)
      CCQ_LAST_PLATFORM_ERROR="无法确认 glibc 环境（ldd/getconf 均不可用）；ccq 仅提供 glibc 版本"
      return 1
      ;;
  esac
  ccq_linux_arch >/dev/null || return 1
  [ "${wsl}" = "wsl2" ] && ccq_ui_warning "检测到 WSL2：属于尽力兼容环境，未纳入正式 CI"
  return 0
}

ccq_linux_require_runtime_user() {
  # Linux + Bash ≥ 4 + 非 root。--list-steps / --help 不经过这里。
  if ! ccq_is_linux; then
    CCQ_LAST_PLATFORM_ERROR="不支持的平台: $(uname -s 2>/dev/null || printf unknown)（Linux 安装器仅支持 Linux）"
    return 1
  fi
  if ! ccq_linux_bash_ok; then
    CCQ_LAST_PLATFORM_ERROR="需要 Bash 4 或更高版本，当前: ${BASH_VERSION:-unknown}"
    return 1
  fi
  if ccq_linux_is_root; then
    CCQ_LAST_PLATFORM_ERROR="请勿以 root 运行安装器；请切换到普通用户后重新运行（安装系统包时会单独调用 sudo）"
    return 1
  fi
  return 0
}
