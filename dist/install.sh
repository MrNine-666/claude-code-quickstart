#!/usr/bin/env bash
set +x 2>/dev/null || true
# ═══════════════════════════════════════════════════════════════════════════════
# 本文件由 build.sh 自动生成，请勿手动编辑
# 生成时间: 2026-10-09T05:47:50.730Z
# ═══════════════════════════════════════════════════════════════════════════════
if [ -z "${ZSH_VERSION:-}" ]; then
  if [ -x "/bin/zsh" ]; then
    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then
      exec /bin/zsh "${BASH_SOURCE[0]}" "$@"
    fi
    ccq_streamed_script="$(mktemp "${TMPDIR:-/tmp}/ccq-built.XXXXXX")" || exit 1
    cat > "${ccq_streamed_script}"
    export CCQ_STREAMED_SCRIPT_PATH="${ccq_streamed_script}"
    exec /bin/zsh "${ccq_streamed_script}" "$@"
  fi
  printf '%s\n' 'CCQ macOS built script requires /bin/zsh.' >&2
  exit 1
fi
export CCQ_BUILT_MODE=1
ccq_cleanup_built_artifacts() {
  if [ -n "${CCQ_STREAMED_SCRIPT_PATH:-}" ]; then rm -f "${CCQ_STREAMED_SCRIPT_PATH}"; fi
  if [ -n "${CCQ_BUILT_CONTRACTS_DIR:-}" ]; then rm -rf "${CCQ_BUILT_CONTRACTS_DIR}"; fi
}
trap ccq_cleanup_built_artifacts EXIT
CCQ_BUILT_CONTRACTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ccq-contracts.XXXXXX")" || exit 1
export CCQ_BUILT_CONTRACTS_DIR
export CCQ_CONTRACTS_DIR="${CCQ_BUILT_CONTRACTS_DIR}"
export CCQ_STEPS_CONTRACT="${CCQ_BUILT_CONTRACTS_DIR}/steps.json"
cat > "${CCQ_BUILT_CONTRACTS_DIR}/steps.json" <<'CCQ_CONTRACT_STEPS_JSON'
{
  "SchemaVersion": 1,
  "Source": "installer/windows/core/Registry.ps1",
  "DirectoryPolicy": {
    "InstallerRoot": "installer",
    "MustNotRenameTo": "src",
    "RuntimeCoreDirectories": {
      "Windows": "installer/windows/core",
      "MacOS": "installer/macos/core"
    }
  },
  "LifecycleStates": [
    "Pending",
    "Running",
    "Success",
    "Failed",
    "Skipped",
    "Unsupported",
    "ManualRequired"
  ],
  "Groups": {
    "Basic": {
      "Label": "基础环境",
      "Description": "ccq 运行所需基础环境",
      "InstallMode": "OneClickOnly",
      "StepIds": [
        "NodeJS",
        "Git"
      ]
    }
  },
  "Steps": [
    {
      "StepId": "NodeJS",
      "StepName": "Node.js",
      "Description": "安装 Node.js，Windows/macOS 均优先复用现有 node/npm：版本达标则直接跳过；不达标时优先在当前 provider 内安装/更新到 LTS；Windows 无法安全修复时提供 nvm-windows / Node.js 直装兜底，macOS 无法原地修复时通过 nvm 官方脚本兜底；不做跨 provider 迁移",
      "StepFile": "windows/steps/NodeJS.ps1",
      "MacOSStepFile": "macos/steps/NodeJS.zsh",
      "SubModules": [
        "windows/steps/NodeJS-Detect.ps1",
        "windows/steps/NodeJS-Common.ps1",
        "windows/steps/NodeJS-Nvm.ps1",
        "windows/steps/NodeJS-Direct.ps1"
      ],
      "TestFunction": "Test-NodeJSInstalled",
      "InstallFunction": "Install-NodeJS",
      "VerifyFunction": "Verify-NodeJS",
      "UpdateFunction": "",
      "SkipIfInstalled": true,
      "MacOSSkipIfInstalled": true,
      "SkipIfInstalledWhenAutoAdded": true,
      "IsOptional": false,
      "Order": 10,
      "Dependencies": [],
      "Group": "Basic"
    },
    {
      "StepId": "Git",
      "StepName": "Git",
      "Description": "安装 Git 版本控制系统",
      "StepFile": "windows/steps/Git.ps1",
      "MacOSStepFile": "macos/steps/Git.zsh",
      "TestFunction": "Test-GitInstalled",
      "InstallFunction": "Install-Git",
      "VerifyFunction": "Verify-Git",
      "UpdateFunction": "",
      "SkipIfInstalled": true,
      "IsOptional": false,
      "Order": 20,
      "Dependencies": [],
      "Group": "Basic"
    }
  ]
}
CCQ_CONTRACT_STEPS_JSON

# 原始文件:
#   - macos/core/Load.zsh
#   - macos/core/Ui.zsh
#   - macos/core/Ccq.zsh
#   - macos/core/Process.zsh
#   - macos/core/Profile.zsh
#   - macos/core/Platform.zsh
#   - macos/core/PackageManager.zsh
#   - macos/core/Json.zsh
#   - macos/core/Registry.zsh
#   - macos/core/Bootstrap.zsh
#   - macos/core/Update.zsh
#   - macos/steps/NodeJS.zsh
#   - macos/steps/Git.zsh
#   - macos/Install.zsh

# ─── 来自: macos/core/Load.zsh ────────────────────────────────────────

# Load.zsh - macOS core 加载顺序与加载函数的唯一声明处
# 功能: 以唯一一份有序声明 CCQ_CORE_ORDER 驱动 source 模式 core 加载。
# 说明: Install.zsh 与 Download-Tui.zsh 都只 source 本文件并调用 ccq_load_core，
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


# ─── 来自: macos/core/Ui.zsh ────────────────────────────────────────

# Ui.zsh - macOS 终端 UI 组件
# 功能: 语义输出、状态文案、箭头键单选/多选菜单、摘要表格与错误详情

if [ -n "${CCQ_UI_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_UI_ZSH_LOADED=1

: "${CCQ_OUTPUT_MODE:=normal}"
: "${CCQ_SUPPORTS_ANSI:=auto}"

ccq_detect_ansi() {
  if [ "${CCQ_SUPPORTS_ANSI}" = "0" ] || [ "${NO_COLOR:-}" != "" ]; then
    return 1
  fi
  if [ "${CCQ_SUPPORTS_ANSI}" = "1" ]; then
    return 0
  fi
  [ -t 1 ] && [ "${TERM:-dumb}" != "dumb" ]
}

ccq_detect_tty_ansi() {
  if [ "${CCQ_SUPPORTS_ANSI}" = "0" ] || [ "${NO_COLOR:-}" != "" ]; then
    return 1
  fi
  if [ "${CCQ_SUPPORTS_ANSI}" = "1" ]; then
    return 0
  fi
  [ -r /dev/tty ] && [ -w /dev/tty ] && [ "${TERM:-dumb}" != "dumb" ]
}

ccq_hex_component_to_byte() {
  local component="${1:-}"
  local length value
  case "${component}" in
    ''|*[!0-9A-Fa-f]*) return 1 ;;
  esac
  length="${#component}"
  [ "${length}" -ge 1 ] && [ "${length}" -le 4 ] || return 1
  value=$((16#${component}))
  case "${length}" in
    1) printf '%s\n' $((value * 17)) ;;
    2) printf '%s\n' "${value}" ;;
    3) printf '%s\n' $(((value + 136) / 273)) ;;
    *) printf '%s\n' $((value / 257)) ;;
  esac
}

ccq_theme_from_colorfgbg() {
  local raw="${COLORFGBG:-}"
  local -a parts
  local bg
  [ -n "${raw}" ] || return 1
  parts=("${(@s/;/)raw}")
  [ "${#parts[@]}" -gt 0 ] || return 1
  bg="${parts[-1]}"
  case "${bg}" in
    ''|*[!0-9]*) return 1 ;;
  esac
  if [ "${bg}" -le 6 ] || [ "${bg}" -eq 8 ]; then
    printf 'dark\n'
  else
    printf 'light\n'
  fi
}

ccq_query_background_rgb_osc11() {
  local response="" ch i=0
  local r g b rb gb bb luminance
  ccq_detect_tty_ansi || return 1

  printf '\033]11;?\a' > /dev/tty 2>/dev/null || return 1
  while [ "${i}" -lt 20 ]; do
    if IFS= read -r -s -k 1 -t 0.015 ch < /dev/tty 2>/dev/null; then
      response="${response}${ch}"
      [ "${ch}" = $'\a' ] && break
    else
      i=$((i + 1))
    fi
  done

  if [[ "${response}" =~ 'rgb:([0-9A-Fa-f]{1,4})/([0-9A-Fa-f]{1,4})/([0-9A-Fa-f]{1,4})' ]]; then
    r="${match[1]}"
    g="${match[2]}"
    b="${match[3]}"
    rb="$(ccq_hex_component_to_byte "${r}" 2>/dev/null)" || return 1
    gb="$(ccq_hex_component_to_byte "${g}" 2>/dev/null)" || return 1
    bb="$(ccq_hex_component_to_byte "${b}" 2>/dev/null)" || return 1
    luminance=$((299 * rb + 587 * gb + 114 * bb))
    if [ "${luminance}" -ge 127500 ]; then
      printf 'light\n'
    else
      printf 'dark\n'
    fi
    return 0
  fi

  return 1
}

ccq_detect_theme() {
  local theme
  theme="$(ccq_query_background_rgb_osc11 2>/dev/null || true)"
  case "${theme}" in
    dark|light) printf '%s\n' "${theme}"; return 0 ;;
  esac
  theme="$(ccq_theme_from_colorfgbg 2>/dev/null || true)"
  case "${theme}" in
    dark|light) printf '%s\n' "${theme}"; return 0 ;;
  esac
  printf 'dark\n'
}

if ccq_detect_ansi; then
  CCQ_ANSI_RESET='\033[0m'
  CCQ_ANSI_SUCCESS='\033[92m'
  CCQ_ANSI_PRIMARY='\033[38;2;217;119;87m'
  CCQ_ANSI_WARNING='\033[93m'
  CCQ_ANSI_DANGER='\033[91m'
  CCQ_ANSI_INFO='\033[97m'
  CCQ_ANSI_DIM='\033[90m'
else
  CCQ_ANSI_RESET=''
  CCQ_ANSI_SUCCESS=''
  CCQ_ANSI_PRIMARY=''
  CCQ_ANSI_WARNING=''
  CCQ_ANSI_DANGER=''
  CCQ_ANSI_INFO=''
  CCQ_ANSI_DIM=''
fi

CCQ_TERMINAL_THEME="$(ccq_detect_theme 2>/dev/null || printf 'dark')"
if [ "${CCQ_TERMINAL_THEME}" = "light" ] && ccq_detect_ansi; then
  CCQ_ANSI_SUCCESS='\033[32m'
  CCQ_ANSI_PRIMARY='\033[38;2;184;92;62m'
  CCQ_ANSI_WARNING='\033[33m'
  CCQ_ANSI_DANGER='\033[31m'
  CCQ_ANSI_INFO='\033[30m'
  CCQ_ANSI_DIM='\033[38;2;106;106;106m'
fi

ccq_set_output_mode() {
  case "${1:-normal}" in
    normal|developer) CCQ_OUTPUT_MODE="$1" ;;
    *) CCQ_OUTPUT_MODE="normal" ;;
  esac
}

ccq_should_print_level() {
  local level="${1:-essential}"
  if [ "${CCQ_OUTPUT_MODE}" = "developer" ]; then
    return 0
  fi
  [ "${level}" = "essential" ]
}

ccq_output_is_developer() {
  [ "${CCQ_OUTPUT_MODE}" = "developer" ]
}

ccq_ui_runtime_write() {
  local type="${1:-info}"
  local message="${2:-}"
  local level="${3:-developer}"

  ccq_should_print_level "${level}" || return 1
  ccq_tty_available || return 1
  ccq_tty_write "${type}" "${message}"
}

ccq_ui_runtime_info() { ccq_ui_runtime_write info "${1:-}" "${2:-developer}"; }
ccq_ui_runtime_dim() { ccq_ui_runtime_write dim "${1:-}" "${2:-developer}"; }
ccq_ui_runtime_warning() { ccq_ui_runtime_write warning "${1:-}" "${2:-developer}"; }
ccq_ui_runtime_success() { ccq_ui_runtime_write success "${1:-}" "${2:-developer}"; }
ccq_ui_runtime_danger() { ccq_ui_runtime_write danger "${1:-}" "${2:-developer}"; }

ccq_ui_write() {
  local type="${1:-info}"
  local message="${2:-}"
  local level="${3:-essential}"
  local newline="${4:-1}"
  local color="${CCQ_ANSI_INFO}"

  ccq_should_print_level "${level}" || return 0

  case "${type}" in
    success) color="${CCQ_ANSI_SUCCESS}" ;;
    primary) color="${CCQ_ANSI_PRIMARY}" ;;
    warning) color="${CCQ_ANSI_WARNING}" ;;
    danger) color="${CCQ_ANSI_DANGER}" ;;
    dim) color="${CCQ_ANSI_DIM}" ;;
    info|*) color="${CCQ_ANSI_INFO}" ;;
  esac

  if [ "${newline}" = "0" ]; then
    printf "%b%s%b" "${color}" "${message}" "${CCQ_ANSI_RESET}"
  else
    printf "%b%s%b\n" "${color}" "${message}" "${CCQ_ANSI_RESET}"
  fi
}

ccq_ui_success() { ccq_ui_write success "${1:-}" "${2:-essential}" "${3:-1}"; }
ccq_ui_primary() { ccq_ui_write primary "${1:-}" "${2:-essential}" "${3:-1}"; }
ccq_ui_warning() { ccq_ui_write warning "${1:-}" "${2:-essential}" "${3:-1}"; }
ccq_ui_danger() { ccq_ui_write danger "${1:-}" "${2:-essential}" "${3:-1}"; }
ccq_ui_info() { ccq_ui_write info "${1:-}" "${2:-essential}" "${3:-1}"; }
ccq_ui_dim() { ccq_ui_write dim "${1:-}" "${2:-essential}" "${3:-1}"; }

ccq_tty_available() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

ccq_tty_write() {
  local type="${1:-info}"
  local message="${2:-}"
  local newline="${3:-1}"
  local color="${CCQ_ANSI_INFO}"

  case "${type}" in
    success) color="${CCQ_ANSI_SUCCESS}" ;;
    primary) color="${CCQ_ANSI_PRIMARY}" ;;
    warning) color="${CCQ_ANSI_WARNING}" ;;
    danger) color="${CCQ_ANSI_DANGER}" ;;
    dim) color="${CCQ_ANSI_DIM}" ;;
    info|*) color="${CCQ_ANSI_INFO}" ;;
  esac

  if [ "${newline}" = "0" ]; then
    printf "%b%s%b" "${color}" "${message}" "${CCQ_ANSI_RESET}" > /dev/tty
  else
    printf "%b%s%b\n" "${color}" "${message}" "${CCQ_ANSI_RESET}" > /dev/tty
  fi
}

ccq_status_label() {
  case "${1:-}" in
    Success|success|PASS|pass) printf '[PASS]' ;;
    Failed|failed|FAIL|fail) printf '[FAIL]' ;;
    Skipped|skipped|SKIP|skip) printf '[SKIP]' ;;
    Unsupported|unsupported) printf '[UNSUPPORTED]' ;;
    ManualRequired|manual|required) printf '[MANUAL]' ;;
    Running|running) printf '[RUN]' ;;
    Pending|pending) printf '[PENDING]' ;;
    *) printf '[INFO]' ;;
  esac
}

ccq_result_field_from_text() {
  local result="${1:-}"
  local field="${2:-}"
  local line
  [ -n "${field}" ] || return 1
  for line in ${(f)result}; do
    if [[ "${line}" == "${field}="* ]]; then
      printf '%s\n' "${line#${field}=}"
      return 0
    fi
  done
  return 1
}

ccq_first_line() {
  local text="${1:-}"
  text="${text%%$'\n'*}"
  printf '%s\n' "${text}"
}

ccq_get_step_status_message() {
  local step_name="${1:-}"
  local step_status="${2:-Info}"
  local message="${3:-}"
  local detail

  case "${step_status}" in
    Running|running)
      printf '  ...... %s\n' "${step_name}"
      ;;
    Success|success|PASS|pass)
      case "${message}" in
        ''|'步骤安装成功') printf '✅ %s 已安装\n' "${step_name}" ;;
        *) printf '✅ %s %s\n' "${step_name}" "$(ccq_first_line "${message}")" ;;
      esac
      ;;
    Skipped|skipped|SKIP|skip)
      if [[ "${message}" == *"已安装"* ]]; then
        printf '✅ %s 已安装\n' "${step_name}"
      elif [ -n "${message}" ] && [ "${message}" != "已跳过" ]; then
        printf '⏭ %s %s\n' "${step_name}" "$(ccq_first_line "${message}")"
      else
        printf '⏭ %s 已跳过\n' "${step_name}"
      fi
      ;;
    Failed|failed|FAIL|fail)
      detail="$(ccq_result_field_from_text "${message}" "ErrorMessage" 2>/dev/null || true)"
      [ -n "${detail}" ] || detail="$(ccq_first_line "${message}")"
      if [ -n "${detail}" ]; then
        printf '❌ %s 安装失败 - %s\n' "${step_name}" "${detail}"
      else
        printf '❌ %s 安装失败\n' "${step_name}"
      fi
      ;;
    ManualRequired|manual|required|Unsupported|unsupported)
      detail="$(ccq_result_field_from_text "${message}" "ErrorMessage" 2>/dev/null || true)"
      [ -n "${detail}" ] || detail="$(ccq_first_line "${message}")"
      if [ -n "${detail}" ]; then
        printf '⏭ %s 需手动处理 - %s\n' "${step_name}" "${detail}"
      else
        printf '⏭ %s 需手动处理\n' "${step_name}"
      fi
      ;;
    *)
      if [ -n "${message}" ]; then
        printf '  %s %s\n' "${step_name}" "$(ccq_first_line "${message}")"
      else
        printf '  %s\n' "${step_name}"
      fi
      ;;
  esac
}

ccq_show_step_progress() {
  local step_name="${1:-}"
  local step_status="${2:-Info}"
  local message="${3:-}"
  local display
  display="$(ccq_get_step_status_message "${step_name}" "${step_status}" "${message}")"

  case "${step_status}" in
    Success|success|PASS|pass) ccq_ui_success "${display}" ;;
    Failed|failed|FAIL|fail) ccq_ui_danger "${display}" ;;
    Skipped|skipped|SKIP|skip|Unsupported|unsupported|ManualRequired|manual|required) ccq_ui_warning "${display}" ;;
    Running|running) ccq_ui_primary "${display}" ;;
    *) ccq_ui_info "${display}" ;;
  esac
}

ccq_string_display_width() {
  local text="${1:-}"
  if [ -z "${text}" ]; then
    printf '0\n'
    return 0
  fi

  if command -v perl >/dev/null 2>&1; then
    perl -CS -Mutf8 -e '
      my $s = shift // "";
      my $width = 0;
      for my $ch (split //, $s) {
        my $code = ord($ch);
        if (($code >= 0x2E80 && $code <= 0x9FFF) ||
            ($code >= 0x3000 && $code <= 0x303F) ||
            ($code >= 0x3400 && $code <= 0x4DBF) ||
            ($code >= 0xF900 && $code <= 0xFAFF) ||
            ($code >= 0xFE30 && $code <= 0xFE4F) ||
            ($code >= 0xFF00 && $code <= 0xFF60) ||
            ($code >= 0xFFE0 && $code <= 0xFFE6) ||
            ($code >= 0x1F300 && $code <= 0x1FAFF)) {
          $width += 2;
        } else {
          $width += 1;
        }
      }
      print $width;
    ' -- "${text}"
    return 0
  fi

  printf '%s\n' "${#text}"
}

ccq_display_pad() {
  local text="${1:-}"
  local width="${2:-0}"
  local current padding
  current="$(ccq_string_display_width "${text}")"
  if [ "${current}" -ge "${width}" ]; then
    printf '%s' "${text}"
    return 0
  fi
  padding=$((width - current))
  printf '%s%*s' "${text}" "${padding}" ''
}

ccq_repeat_char() {
  local char="${1:- }"
  local count="${2:-0}"
  local out=""
  local i=0
  while [ "${i}" -lt "${count}" ]; do
    out="${out}${char}"
    i=$((i + 1))
  done
  printf '%s' "${out}"
}

ccq_show_banner() {
  local subtitle="${1:-Claude Code Quickstart}"
  local logo_lines=(
    "  ██████╗  ██████╗  ██████╗ "
    " ██╔════╝ ██╔════╝ ██╔═══██╗"
    " ██║      ██║      ██║   ██║"
    " ██║      ██║      ██║▄▄ ██║"
    "  ╚██████╗ ╚██████╗ ╚██████╔╝"
    "  ╚═════╝  ╚═════╝  ╚══▀▀═╝ "
  )
  local line

  printf '\n'
  for line in "${logo_lines[@]}"; do
    ccq_ui_primary "${line}"
  done

  if [ -n "${subtitle}" ]; then
    printf '\n'
    ccq_ui_primary "  ${subtitle}"
  fi
  printf '\n'
}

ccq_get_terminal_width() {
  local width="${COLUMNS:-80}"
  case "${width}" in
    ''|*[!0-9]*) width=80 ;;
  esac
  [ "${width}" -gt 0 ] || width=80
  printf '%s\n' "${width}"
}

ccq_menu_item_physical_lines() {
  local prefix="${1:-}"
  local option_text="${2:-}"
  local term_width display_width lines
  term_width="$(ccq_get_terminal_width)"
  display_width=$(( $(ccq_string_display_width "${prefix}") + $(ccq_string_display_width "${option_text}") ))
  lines=$(( (display_width + term_width - 1) / term_width ))
  [ "${lines}" -gt 0 ] || lines=1
  printf '%s\n' "${lines}"
}

ccq_menu_is_selected() {
  local needle="${1:-}"
  shift || true
  local item
  for item in "$@"; do
    [ "${item}" = "${needle}" ] && return 0
  done
  return 1
}

ccq_menu_toggle_selected() {
  local needle="${1:-}"
  shift || true
  local item
  local -a next=()
  if ccq_menu_is_selected "${needle}" "$@"; then
    for item in "$@"; do
      [ "${item}" != "${needle}" ] && next+=("${item}")
    done
  else
    next=("$@" "${needle}")
  fi
  printf '%s\n' "${next[@]}"
}

ccq_menu_read_key() {
  local key next third
  IFS= read -r -s -k 1 key < /dev/tty || return 1
  case "${key}" in
    $'\033')
      if IFS= read -r -s -k 1 -t 0.08 next < /dev/tty 2>/dev/null; then
        if [ "${next}" = "[" ]; then
          IFS= read -r -s -k 1 -t 0.08 third < /dev/tty 2>/dev/null || third=""
          case "${third}" in
            A) printf 'up\n' ;;
            B) printf 'down\n' ;;
            *) printf 'escape\n' ;;
          esac
        else
          printf 'escape\n'
        fi
      else
        printf 'escape\n'
      fi
      ;;
    $'\n'|$'\r') printf 'enter\n' ;;
    ' ') printf 'space\n' ;;
    q|Q) printf 'escape\n' ;;
    *) printf 'other\n' ;;
  esac
}

ccq_menu_move_to_start() {
  local lines="${1:-0}"
  [ "${lines}" -gt 0 ] || return 0
  printf '\033[%sA' "${lines}" > /dev/tty
}

ccq_show_single_select_menu_fallback() {
  local title="${1:-请选择}"
  local default_index="${2:-0}"
  shift 2 || true
  local options=("$@")
  local count="${#options[@]}"
  local choice i

  ccq_tty_write primary "${title}"
  printf '\n' > /dev/tty
  i=1
  for choice in "${options[@]}"; do
    printf '  %s. %s\n' "${i}" "${choice}" > /dev/tty
    i=$((i + 1))
  done

  while true; do
    printf '\n请选择 (1-%s)，直接按 Enter 使用默认项，或 q 取消: ' "${count}" > /dev/tty
    IFS= read -r choice < /dev/tty || return 1
    case "${choice}" in
      q|Q) return 1 ;;
      '') printf '%s\n' "${default_index}"; return 0 ;;
      ''|*[!0-9]*) ccq_tty_write danger "无效选择，请输入 1 到 ${count} 之间的数字" ;;
      *)
        if [ "${choice}" -ge 1 ] && [ "${choice}" -le "${count}" ]; then
          printf '%s\n' $((choice - 1))
          return 0
        fi
        ccq_tty_write danger "无效选择，请输入 1 到 ${count} 之间的数字"
        ;;
    esac
  done
}

ccq_show_single_select_menu() {
  local title="${1:-请选择}"
  local default_index="${2:-0}"
  shift 2 || true
  local options=("$@")
  local count="${#options[@]}"
  local selected_index key i line_count=0

  [ "${count}" -gt 0 ] || return 1
  case "${default_index}" in ''|*[!0-9]*) default_index=0 ;; esac
  [ "${default_index}" -ge 0 ] || default_index=0
  [ "${default_index}" -lt "${count}" ] || default_index=$((count - 1))

  if ! ccq_tty_available; then
    printf '%s\n' "${default_index}"
    return 0
  fi

  if ! ccq_detect_tty_ansi; then
    ccq_show_single_select_menu_fallback "${title}" "${default_index}" "${options[@]}"
    return $?
  fi

  selected_index="${default_index}"
  ccq_tty_write primary "${title}"
  printf '\n' > /dev/tty

  i=1
  while [ "${i}" -le "${count}" ]; do
    line_count=$((line_count + $(ccq_menu_item_physical_lines "    " "${options[$i]}")))
    i=$((i + 1))
  done

  printf '\033[?25l' > /dev/tty
  while true; do
    printf '\033[J' > /dev/tty
    i=1
    while [ "${i}" -le "${count}" ]; do
      if [ $((i - 1)) -eq "${selected_index}" ]; then
        ccq_tty_write success "  ► ${options[$i]}"
      else
        printf '    %s\n' "${options[$i]}" > /dev/tty
      fi
      i=$((i + 1))
    done

    key="$(ccq_menu_read_key || printf 'escape')"
    case "${key}" in
      up) selected_index=$(((selected_index - 1 + count) % count)); ccq_menu_move_to_start "${line_count}" ;;
      down) selected_index=$(((selected_index + 1) % count)); ccq_menu_move_to_start "${line_count}" ;;
      enter) printf '\n\033[?25h' > /dev/tty; printf '%s\n' "${selected_index}"; return 0 ;;
      escape) printf '\n\033[?25h' > /dev/tty; return 1 ;;
      *) ccq_menu_move_to_start "${line_count}" ;;
    esac
  done
}

ccq_show_multi_select_menu_fallback() {
  local title="${1:-请选择}"
  local default_indices="${2:-}"
  shift 2 || true
  local options=("$@")
  local count="${#options[@]}"
  local selected=() choice item i checked

  for item in ${default_indices}; do
    case "${item}" in
      ''|*[!0-9]*) ;;
      *) [ "${item}" -ge 0 ] && [ "${item}" -lt "${count}" ] && selected+=("${item}") ;;
    esac
  done

  ccq_tty_write primary "${title}"
  printf '\n' > /dev/tty
  i=1
  while [ "${i}" -le "${count}" ]; do
    checked='[ ]'
    ccq_menu_is_selected "$((i - 1))" "${selected[@]}" && checked='[✓]'
    printf '  %s. %s %s\n' "${i}" "${checked}" "${options[$i]}" > /dev/tty
    i=$((i + 1))
  done

  printf '\n输入要切换的选项编号（用空格分隔），或直接按 Enter 确认: ' > /dev/tty
  IFS= read -r choice < /dev/tty || return 1
  case "${choice}" in
    q|Q) return 1 ;;
  esac
  if [ -n "${choice}" ]; then
    for item in ${choice}; do
      case "${item}" in
        ''|*[!0-9]*) ;;
        *)
          if [ "${item}" -ge 1 ] && [ "${item}" -le "${count}" ]; then
            selected=( $(ccq_menu_toggle_selected "$((item - 1))" "${selected[@]}") )
          fi
          ;;
      esac
    done
  fi

  i=0
  while [ "${i}" -lt "${count}" ]; do
    ccq_menu_is_selected "${i}" "${selected[@]}" && printf '%s\n' "${i}"
    i=$((i + 1))
  done
}

ccq_show_multi_select_menu() {
  local title="${1:-请选择}"
  local default_indices="${2:-}"
  shift 2 || true
  local options=("$@")
  local count="${#options[@]}"
  local selected=() item selected_index=0 key i line_count=0 checked

  [ "${count}" -gt 0 ] || return 1

  for item in ${default_indices}; do
    case "${item}" in
      ''|*[!0-9]*) ;;
      *) [ "${item}" -ge 0 ] && [ "${item}" -lt "${count}" ] && selected+=("${item}") ;;
    esac
  done

  if ! ccq_tty_available; then
    i=0
    while [ "${i}" -lt "${count}" ]; do
      ccq_menu_is_selected "${i}" "${selected[@]}" && printf '%s\n' "${i}"
      i=$((i + 1))
    done
    return 0
  fi

  if ! ccq_detect_tty_ansi; then
    ccq_show_multi_select_menu_fallback "${title}" "${default_indices}" "${options[@]}"
    return $?
  fi

  ccq_tty_write primary "${title}"
  printf '\n' > /dev/tty
  ccq_tty_write dim "使用 ↑↓ 导航，空格键选择/取消，Enter 确认，Esc 取消"
  printf '\n' > /dev/tty

  i=1
  while [ "${i}" -le "${count}" ]; do
    line_count=$((line_count + $(ccq_menu_item_physical_lines "    [ ] " "${options[$i]}")))
    i=$((i + 1))
  done

  printf '\033[?25l' > /dev/tty
  while true; do
    printf '\033[J' > /dev/tty
    i=1
    while [ "${i}" -le "${count}" ]; do
      checked='[ ]'
      ccq_menu_is_selected "$((i - 1))" "${selected[@]}" && checked='[✓]'
      if [ $((i - 1)) -eq "${selected_index}" ]; then
        ccq_tty_write success "  ► ${checked} ${options[$i]}"
      else
        printf '    %s %s\n' "${checked}" "${options[$i]}" > /dev/tty
      fi
      i=$((i + 1))
    done

    key="$(ccq_menu_read_key || printf 'escape')"
    case "${key}" in
      up) selected_index=$(((selected_index - 1 + count) % count)); ccq_menu_move_to_start "${line_count}" ;;
      down) selected_index=$(((selected_index + 1) % count)); ccq_menu_move_to_start "${line_count}" ;;
      space) selected=( $(ccq_menu_toggle_selected "${selected_index}" "${selected[@]}") ); ccq_menu_move_to_start "${line_count}" ;;
      enter)
        printf '\n\033[?25h' > /dev/tty
        i=0
        while [ "${i}" -lt "${count}" ]; do
          ccq_menu_is_selected "${i}" "${selected[@]}" && printf '%s\n' "${i}"
          i=$((i + 1))
        done
        return 0
        ;;
      escape) printf '\n\033[?25h' > /dev/tty; return 1 ;;
      *) ccq_menu_move_to_start "${line_count}" ;;
    esac
  done
}

ccq_select_single() {
  local title="${1:-请选择}"
  shift || true
  ccq_show_single_select_menu "${title}" 0 "$@"
}

ccq_select_multi() {
  local title="${1:-请选择}"
  shift || true
  ccq_show_multi_select_menu "${title}" "" "$@"
}

ccq_summary_status_text() {
  case "${1:-}" in
    Success|success) printf '成功' ;;
    Skipped|skipped) printf '跳过' ;;
    Failed|failed) printf '失败' ;;
    ManualRequired|manual|required|Unsupported|unsupported) printf '需手动处理' ;;
    Pending|pending) printf '未执行' ;;
    *) printf '未知' ;;
  esac
}

ccq_show_install_summary() {
  # 防御式关闭 xtrace，避免外部调试开关污染摘要表格输出。
  set +x 2>/dev/null || true
  unsetopt XTRACE 2>/dev/null || true
  setopt NO_XTRACE 2>/dev/null || true

  local rows=("$@")
  local row name row_status version
  local name_width status_width version_width current_name current_status current_version
  local header_name="组件" header_status="状态" header_version="版本"
  local top mid bottom

  if [ "${#rows[@]}" -eq 0 ]; then
    ccq_ui_warning "没有安装项目"
    return 0
  fi

  name_width="$(ccq_string_display_width "${header_name}")"
  status_width="$(ccq_string_display_width "${header_status}")"
  version_width="$(ccq_string_display_width "${header_version}")"

  for row in "${rows[@]}"; do
    IFS=$'\t' read -r name row_status version <<< "${row}"
    [ -n "${version}" ] || version='-'
    current_name="$(ccq_string_display_width "${name}")"
    current_status="$(ccq_string_display_width "${row_status}")"
    current_version="$(ccq_string_display_width "${version}")"
    [ "${current_name}" -gt "${name_width}" ] && name_width="${current_name}"
    [ "${current_status}" -gt "${status_width}" ] && status_width="${current_status}"
    [ "${current_version}" -gt "${version_width}" ] && version_width="${current_version}"
  done

  [ "${name_width}" -lt 10 ] && name_width=10
  [ "${status_width}" -lt 8 ] && status_width=8
  [ "${version_width}" -lt 8 ] && version_width=8

  top="┌$(ccq_repeat_char '─' $((name_width + 2)))┬$(ccq_repeat_char '─' $((status_width + 2)))┬$(ccq_repeat_char '─' $((version_width + 2)))┐"
  mid="├$(ccq_repeat_char '─' $((name_width + 2)))┼$(ccq_repeat_char '─' $((status_width + 2)))┼$(ccq_repeat_char '─' $((version_width + 2)))┤"
  bottom="└$(ccq_repeat_char '─' $((name_width + 2)))┴$(ccq_repeat_char '─' $((status_width + 2)))┴$(ccq_repeat_char '─' $((version_width + 2)))┘"

  ccq_ui_dim "${top}"
  ccq_ui_info "│ $(ccq_display_pad "${header_name}" "${name_width}") │ $(ccq_display_pad "${header_status}" "${status_width}") │ $(ccq_display_pad "${header_version}" "${version_width}") │"
  ccq_ui_dim "${mid}"

  for row in "${rows[@]}"; do
    IFS=$'\t' read -r name row_status version <<< "${row}"
    [ -n "${version}" ] || version='-'
    local rendered="│ $(ccq_display_pad "${name}" "${name_width}") │ $(ccq_display_pad "${row_status}" "${status_width}") │ $(ccq_display_pad "${version}" "${version_width}") │"
    case "${row_status}" in
      *成功*|*已安装*) ccq_ui_success "${rendered}" ;;
      *失败*|*错误*) ccq_ui_danger "${rendered}" ;;
      *跳过*|*手动*) ccq_ui_warning "${rendered}" ;;
      *) ccq_ui_info "${rendered}" ;;
    esac
  done

  ccq_ui_dim "${bottom}"
}

ccq_show_error_details() {
  local friendly_message="${1:-CCQ 遇到未预期的错误}"
  local technical_details="${2:-}"
  local show_details="${3:-0}"
  local key

  ccq_ui_danger "❌ ${friendly_message}"

  if [ -n "${technical_details}" ]; then
    if [ "${show_details}" = "1" ]; then
      printf '\n'
      ccq_ui_info "技术详情："
      ccq_ui_dim "${technical_details}"
    elif ccq_tty_available; then
      printf '\n'
      ccq_ui_dim "按 [D] 键查看技术详情，或其他键跳过..."
      IFS= read -r -s -k 1 key < /dev/tty || key=""
      printf '\n'
      case "${key}" in
        d|D)
          ccq_ui_info "技术详情："
          ccq_ui_dim "${technical_details}"
          ;;
      esac
    fi
  fi

  printf '\n'
}


# ─── 来自: macos/core/Ccq.zsh ────────────────────────────────────────

# Ccq.zsh - ccq 可执行文件管理（macOS 平台唯一实现）
# 功能: 架构/路径检测、版本规范化、已安装探测、下载（gzip-first/raw fallback）、
#       chmod +x 落盘、幂等 ~/.zprofile PATH 写入，以及 Release URL/版本与下载 handoff。
# 说明: 完整 install 与 Download-Tui.zsh 专用入口都通过 core/Load.zsh 加载本文件，
#       消费同一实现；本文件是这些 CCQ 行为函数的唯一声明处。
# ─── CCQ 可执行文件管理 ──────────────────────────────────────────────────────

# ccq_get_architecture 的失败原因（仅 Darwin x64/arm64 受支持）。
CCQ_PLATFORM_ERROR=""

ccq_get_architecture() {
  # 检测当前平台架构，返回 ccq 可执行文件对应的 target 名称
  # 输出: "macos-x64" | "macos-arm64"
  # 仅支持 Darwin（macOS）与 x86_64/arm64；错误 OS 或未知架构明确失败，不回退猜测。
  CCQ_PLATFORM_ERROR=""
  local kernel arch
  kernel="$(uname -s 2>/dev/null || true)"
  if [ "${kernel}" != "Darwin" ]; then
    CCQ_PLATFORM_ERROR="不支持的平台: ${kernel:-unknown}（CCQ 专用入口仅支持 macOS）"
    return 1
  fi

  arch="$(uname -m 2>/dev/null || true)"
  case "${arch}" in
    arm64|aarch64)
      printf 'macos-arm64'
      ;;
    x86_64|amd64)
      printf 'macos-x64'
      ;;
    *)
      CCQ_PLATFORM_ERROR="无法识别的处理器架构: ${arch:-unknown}"
      return 1
      ;;
  esac
}

ccq_get_executable_path() {
  # 返回 ccq 可执行文件应安装的目标路径（macOS: ~/.local/bin/ccq）
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
  # 检测 ccq 可执行文件是否已安装且可用
  # 输出 JSON: {"isInstalled":true/false,"version":"x.y.z","path":"..."}
  local ccq_path is_installed=0 version=""
  ccq_path="$(ccq_get_executable_path)"

  if [ -f "${ccq_path}" ] && [ -x "${ccq_path}" ]; then
    # 只信任可快速响应 --version 的 ccq；旧/损坏可执行文件可能卡住，必须允许后续重新下载覆盖。
    local version_file version_pid waited=0
    version_file="$(mktemp -t ccq_version.XXXXXX 2>/dev/null || printf '%s/.ccq-version-%s' "${TMPDIR:-/tmp}" "$$")"
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
  # 下载单个 URL 到指定临时文件。每次调用都是独立传输，进度只来自当前响应。
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
  # 参数: $1 = 下载 URL
  # 返回: 0 = 成功; 1 = 失败
  local download_url="$1"
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
    command -v ccq_ui_info >/dev/null 2>&1 && ccq_ui_info "创建 ccq 目录: ${ccq_bin_dir}"
  fi

  # 2. 优先传输 gzip 资产；不可用或损坏时重新开始一次 raw 下载。
  command -v ccq_ui_info >/dev/null 2>&1 && ccq_ui_info "正在下载 ccq 可执行文件..."
  command -v ccq_ui_dim >/dev/null 2>&1 && ccq_ui_dim "  URL: ${gzip_url}"

  rm -f "${tmp_path}" "${gzip_tmp_path}" 2>/dev/null || true
  if ccq_download_file "${gzip_url}" "${gzip_tmp_path}"; then
    if ! command -v gzip >/dev/null 2>&1; then
      gzip_error="系统 gzip 命令不可用"
    elif gzip -dc -- "${gzip_tmp_path}" > "${tmp_path}" && [ -s "${tmp_path}" ]; then
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
    if command -v ccq_ui_warning >/dev/null 2>&1; then
      ccq_ui_warning "gzip 传输失败（${gzip_error}），正在改用 raw 资产..."
    else
      printf 'Warning: gzip 传输失败（%s），正在改用 raw 资产...\n' "${gzip_error}" >&2
    fi
    command -v ccq_ui_dim >/dev/null 2>&1 && ccq_ui_dim "  URL: ${download_url}"

    if ! ccq_download_file "${download_url}" "${tmp_path}"; then
      local raw_error="${CCQ_DOWNLOAD_ERROR:-未知错误}"
      rm -f "${tmp_path}" "${gzip_tmp_path}" 2>/dev/null || true
      printf 'Error: raw 下载失败: %s；gzip 失败上下文: %s\n' "${raw_error}" "${gzip_error}" >&2
      return 1
    fi
  fi

  # 3. 无论来源为何，只有完整且非空的 raw temp 才能进入最终落盘流程。
  if [ ! -f "${tmp_path}" ]; then
    rm -f "${gzip_tmp_path}" 2>/dev/null || true
    if [ "${gzip_ready}" -eq 1 ]; then
      printf 'Error: gzip 解压后的 raw 文件不存在: %s\n' "${tmp_path}" >&2
    else
      printf 'Error: raw 下载失败: 下载后文件不存在；gzip 失败上下文: %s\n' "${gzip_error}" >&2
    fi
    return 1
  fi

  local file_size
  file_size="$(stat -f%z "${tmp_path}" 2>/dev/null || stat -c%s "${tmp_path}" 2>/dev/null || echo 0)"
  if [ "${file_size}" -eq 0 ]; then
    rm -f "${tmp_path}" "${gzip_tmp_path}" 2>/dev/null || true
    if [ "${gzip_ready}" -eq 1 ]; then
      printf 'Error: gzip 解压后的 raw 文件为空\n' >&2
    else
      printf 'Error: raw 下载失败: 下载的文件为空；gzip 失败上下文: %s\n' "${gzip_error}" >&2
    fi
    return 1
  fi

  # 4. 设置可执行权限并原子替换
  rm -f "${gzip_tmp_path}" 2>/dev/null || true
  chmod +x "${tmp_path}" || { rm -f "${tmp_path}" 2>/dev/null || true; printf 'Error: 无法设置可执行权限\n' >&2; return 1; }
  mv -f "${tmp_path}" "${ccq_path}" || { rm -f "${tmp_path}" 2>/dev/null || true; printf 'Error: 无法安装 ccq 可执行文件\n' >&2; return 1; }

  command -v ccq_ui_success >/dev/null 2>&1 && ccq_ui_success "✓ ccq 可执行文件已下载到: ${ccq_path}"
  command -v ccq_ui_dim >/dev/null 2>&1 && ccq_ui_dim "  文件大小: $(awk "BEGIN {printf \"%.2f\", ${file_size}/1024/1024}") MB"

  # 5. 确保 ~/.local/bin 在 PATH（复用现有逻辑 Process.zsh:220-222）
  if ! printf '%s\n' "${PATH}" | grep -q "${ccq_bin_dir}"; then
    # 添加到 ~/.zprofile（login shell）；文件不存在时幂等创建后再追加。
    if [ ! -f "${HOME}/.zprofile" ]; then
      : > "${HOME}/.zprofile" 2>/dev/null || true
    fi
    if [ -f "${HOME}/.zprofile" ]; then
      if ! grep -q "${ccq_bin_dir}" "${HOME}/.zprofile" 2>/dev/null; then
        printf '\n# ccq executable path\nexport PATH="%s:${PATH}"\n' "${ccq_bin_dir}" >> "${HOME}/.zprofile"
        command -v ccq_ui_success >/dev/null 2>&1 && ccq_ui_success "✓ ${ccq_bin_dir} 已添加到 ~/.zprofile"
      fi
    fi
    command -v ccq_ui_warning >/dev/null 2>&1 && ccq_ui_warning "⚠ 请开启新终端后使用 ccq 命令（当前会话 PATH 尚未刷新）"
  fi

  return 0
}

# ─── CCQ Release 解析与下载 handoff ──────────────────────────────────────────

# 以下 ccq_confirm_executable_download 接收入口模式参数：
#   install   = 完整安装入口，首次未安装时保留「是否现在下载」确认
#   dedicated = 专用下载入口，用户主动运行即视为已授权，跳过首次确认菜单
# 两种模式都保留同版本跳过、版本不一致默认保留、目标版本未知时保留现有可执行文件。
# 返回值（0/1）表示「CCQ 现在是否可用」：
#   0 = 已安装/同版本/按既定策略有意保留或跳过；1 = 确实尝试下载但未得到可用的 ccq。
# 专用入口把该返回值当作退出码；完整 install 沿用既有「告警但不中断」语义。
# 有意跳过（用户拒绝、目标版本未知、选择保留）不算失败，仍返回 0。
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
  # 在 install 末尾或专用下载入口执行 ccq 下载 handoff。
  # 参数: $1 = 模式（install | dedicated，默认 install）
  #   install   = 首次未安装时保留「是否现在下载」确认，用户可拒绝
  #   dedicated = 用户主动运行专用下载脚本即视为首次下载授权，跳过首次确认菜单
  # 两种模式都保留：同版本跳过；版本不一致时显示默认保留的覆盖菜单；目标版本未知时保留现有可执行文件。
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
    # 用户主动运行专用下载入口，本身就是首次下载授权，不再重复询问是否下载。
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

  # 4. 执行下载与安装（返回值 = 本次是否得到可用的 ccq；专用入口据此决定退出码）
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
    # 确实尝试过下载但没有得到可用的 ccq：返回失败，供专用入口以非零码退出。
    return 1
  fi

  return 0
}

# ─── 来自: macos/core/Process.zsh ────────────────────────────────────────

# Process.zsh - macOS 外部命令执行封装
# 功能: 命令检测、版本提取、超时执行、npm/npx 包装

if [ -n "${CCQ_PROCESS_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_PROCESS_ZSH_LOADED=1

: "${CCQ_DEFAULT_TIMEOUT_SECONDS:=300}"
: "${CCQ_DEFAULT_RETRY_COUNT:=3}"

ccq_command_exists() {
  command -v "$1" >/dev/null 2>&1
}

ccq_resolve_command() {
  command -v "$1" 2>/dev/null || true
}

ccq_join_args_for_display() {
  local command_name="${1:-}"
  shift || true
  local text="${command_name}"
  local arg
  for arg in "$@"; do
    text="${text} ${arg}"
  done
  printf '%s' "${text}"
}

ccq_process_stream_enabled() {
  local suppress_output="${1:-0}"
  [ "${suppress_output}" != "1" ] || return 1
  command -v ccq_output_is_developer >/dev/null 2>&1 || return 1
  ccq_output_is_developer || return 1
  command -v ccq_tty_available >/dev/null 2>&1 || return 1
  ccq_tty_available
}

ccq_process_tty_block() {
  local text="${1:-}"
  [ -n "${text}" ] || return 0
  printf '%s\n' "${text}" > /dev/tty 2>/dev/null || true
}

ccq_run_native_command() {
  if ccq_process_stream_enabled 0; then
    "$@" > >(tee /dev/tty >/dev/null) 2> >(tee /dev/tty >/dev/null)
  else
    "$@" >/dev/null 2>&1
  fi
}

ccq_run_command_once() {
  local timeout_seconds="${1:-${CCQ_DEFAULT_TIMEOUT_SECONDS}}"
  local suppress_output="${2:-0}"
  shift 2 || true

  local output_file error_file heartbeat_file exit_code stream_output=0 heartbeat_pid=""
  output_file="$(mktemp -t ccq_cmd_out.XXXXXX)" || return 1
  error_file="$(mktemp -t ccq_cmd_err.XXXXXX)" || { rm -f "${output_file}"; return 1; }
  heartbeat_file="$(mktemp -t ccq_cmd_heartbeat.XXXXXX)" || { rm -f "${output_file}" "${error_file}"; return 1; }

  if ccq_process_stream_enabled "${suppress_output}"; then
    stream_output=1
    (
      sleep 2 || exit 0
      printf '1' > "${heartbeat_file}" 2>/dev/null || true
      elapsed=2
      while true; do
        printf '\r  等待中... (%s 秒)' "${elapsed}" > /dev/tty 2>/dev/null || true
        sleep 1 || exit 0
        elapsed=$((elapsed + 1))
      done
    ) &
    heartbeat_pid="$!"
  fi

  if ccq_command_exists timeout; then
    timeout "${timeout_seconds}" "$@" >"${output_file}" 2>"${error_file}"
    exit_code=$?
  else
    "$@" >"${output_file}" 2>"${error_file}"
    exit_code=$?
  fi

  if [ -n "${heartbeat_pid}" ]; then
    kill "${heartbeat_pid}" >/dev/null 2>&1 || true
    wait "${heartbeat_pid}" 2>/dev/null || true
    if [ -s "${heartbeat_file}" ]; then
      printf '\n' > /dev/tty 2>/dev/null || true
    fi
  fi

  CCQ_LAST_EXIT_CODE="${exit_code}"
  CCQ_LAST_OUTPUT="$(cat "${output_file}" 2>/dev/null || true)"
  CCQ_LAST_ERROR="$(cat "${error_file}" 2>/dev/null || true)"
  if [ "${exit_code}" -eq 124 ] && [ -z "${CCQ_LAST_ERROR}" ]; then
    CCQ_LAST_ERROR="命令执行超时 (${timeout_seconds} 秒): $(ccq_join_args_for_display "$@")"
  fi
  rm -f "${output_file}" "${error_file}" "${heartbeat_file}"

  if [ "${stream_output}" = "1" ]; then
    ccq_process_tty_block "${CCQ_LAST_OUTPUT}"
    ccq_process_tty_block "${CCQ_LAST_ERROR}"
  elif [ "${suppress_output}" != "1" ] && ! command -v ccq_output_is_developer >/dev/null 2>&1 && [ -n "${CCQ_LAST_OUTPUT}" ]; then
    printf '%s\n' "${CCQ_LAST_OUTPUT}"
  fi

  [ "${exit_code}" -eq 0 ]
}

ccq_run_command() {
  local timeout_seconds="${CCQ_DEFAULT_TIMEOUT_SECONDS}"
  local retry_count="${CCQ_DEFAULT_RETRY_COUNT}"
  local suppress_output=0
  local working_directory=""

  while [ "$#" -gt 0 ]; do
    case "$1" in
      --timeout)
        timeout_seconds="$2"
        shift 2
        ;;
      --retries)
        retry_count="$2"
        shift 2
        ;;
      --suppress-output)
        suppress_output=1
        shift
        ;;
      --working-directory)
        working_directory="$2"
        shift 2
        ;;
      --)
        shift
        break
        ;;
      *)
        break
        ;;
    esac
  done

  if [ "$#" -eq 0 ]; then
    CCQ_LAST_EXIT_CODE=127
    CCQ_LAST_OUTPUT=""
    CCQ_LAST_ERROR="未提供命令"
    return 127
  fi

  local attempt=0
  local max_attempts=$((retry_count + 1))
  local display_command
  display_command="$(ccq_join_args_for_display "$@")"

  while [ "${attempt}" -lt "${max_attempts}" ]; do
    attempt=$((attempt + 1))
    if [ -n "${working_directory}" ]; then
      (cd "${working_directory}" && ccq_run_command_once "${timeout_seconds}" "${suppress_output}" "$@")
    else
      ccq_run_command_once "${timeout_seconds}" "${suppress_output}" "$@"
    fi
    local command_status=$?
    if [ "${command_status}" -eq 0 ]; then
      return 0
    fi
    if [ "${attempt}" -lt "${max_attempts}" ]; then
      if command -v ccq_ui_runtime_warning >/dev/null 2>&1; then
        ccq_ui_runtime_warning "命令失败，准备重试(${attempt}/${retry_count}): ${display_command}"
      elif command -v ccq_ui_warning >/dev/null 2>&1; then
        ccq_ui_warning "命令失败，准备重试(${attempt}/${retry_count}): ${display_command}" "developer"
      fi
      sleep $((attempt * 2))
    fi
  done

  return "${CCQ_LAST_EXIT_CODE:-1}"
}

ccq_get_command_version() {
  local command_name="${1:-}"
  local output=""
  if [ -z "${command_name}" ] || ! ccq_command_exists "${command_name}"; then
    return 1
  fi

  output="$(${command_name} --version 2>/dev/null | head -n 1 || true)"
  if [ -z "${output}" ]; then
    output="$(${command_name} -v 2>/dev/null | head -n 1 || true)"
  fi
  printf '%s\n' "${output}"
}

ccq_refresh_path() {
  # macOS 当前 shell 通常无需全量刷新；补充常见 Homebrew、nvm 与 npm 前缀。
  local brew_bin="" brew_prefix=""
  if command -v ccq_brew_command >/dev/null 2>&1; then
    brew_bin="$(ccq_brew_command 2>/dev/null || true)"
  elif ccq_command_exists brew; then
    brew_bin="$(command -v brew 2>/dev/null || true)"
  fi
  if [ -n "${brew_bin}" ]; then
    brew_prefix="$("${brew_bin}" --prefix 2>/dev/null || dirname "$(dirname "${brew_bin}")")"
    if [ -n "${brew_prefix}" ]; then
      case ":${PATH}:" in
        *":${brew_prefix}/bin:"*) ;;
        *) PATH="${brew_prefix}/bin:${PATH}" ;;
      esac
      case ":${PATH}:" in
        *":${brew_prefix}/sbin:"*) ;;
        *) PATH="${brew_prefix}/sbin:${PATH}" ;;
      esac
    fi
  fi

  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) PATH="${HOME}/.local/bin:${PATH}" ;;
  esac

  local nvm_dir="${NVM_DIR:-}"
  if [ -z "${nvm_dir}" ]; then
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then
      nvm_dir="${XDG_CONFIG_HOME%/}/nvm"
    else
      nvm_dir="${HOME}/.nvm"
    fi
  fi
  nvm_dir="${nvm_dir%/}"
  if [ -s "${nvm_dir}/nvm.sh" ]; then
    export NVM_DIR="${nvm_dir}"
    . "${nvm_dir}/nvm.sh" >/dev/null 2>&1 || true
    if ccq_command_exists nvm; then
      nvm use --silent default >/dev/null 2>&1 || nvm use --silent 'lts/*' >/dev/null 2>&1 || true
    fi
  fi

  if ccq_command_exists npm; then
    local npm_prefix
    npm_prefix="$(npm prefix -g 2>/dev/null || true)"
    if [ -n "${npm_prefix}" ]; then
      case ":${PATH}:" in
        *":${npm_prefix}/bin:"*) ;;
        *) PATH="${npm_prefix}/bin:${PATH}" ;;
      esac
    fi
  fi
  export PATH
}

ccq_npm_global_install() {
  local package_name="${1:-}"
  local version="${2:-}"
  local full_package="${package_name}"
  if [ -z "${package_name}" ]; then
    CCQ_LAST_ERROR="npm 包名不能为空"
    return 1
  fi
  if [ -n "${version}" ]; then
    full_package="${package_name}@${version}"
  fi
  ccq_run_command --timeout 300 --retries 3 -- npm install -g "${full_package}"
}

ccq_run_command_developer_or_silent() {
  if command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer; then
    ccq_run_command "$@"
  else
    ccq_run_command --suppress-output "$@" >/dev/null 2>&1
  fi
}

ccq_npx() {
  ccq_run_command --timeout "${CCQ_DEFAULT_TIMEOUT_SECONDS}" --retries 0 -- npx "$@"
}

# npm outdated 全局缓存 - 会话级缓存避免重复查询
CCQ_NPM_OUTDATED_CACHE=""
CCQ_NPM_OUTDATED_CACHED=0

ccq_npm_outdated_global() {
  local force="${1:-0}"

  # 缓存命中且非强制刷新
  if [ "${CCQ_NPM_OUTDATED_CACHED}" = "1" ] && [ "${force}" != "1" ]; then
    printf '%s' "${CCQ_NPM_OUTDATED_CACHE}"
    return 0
  fi

  # npm 不可用时返回空字符串
  if ! ccq_command_exists npm; then
    CCQ_NPM_OUTDATED_CACHE=""
    CCQ_NPM_OUTDATED_CACHED=1
    return 0
  fi

  # 解析 npm 全局前缀，处理 fnm 符号链接
  local npm_prefix
  npm_prefix="$(npm prefix -g 2>/dev/null || true)"

  # fnm 路径修复：解析 /fnm_multishells/ 或 /.fnm/ 的真实路径
  if [ -n "${npm_prefix}" ]; then
    case "${npm_prefix}" in
      *"/fnm_multishells/"*|*"/.fnm/"*)
        if ccq_command_exists readlink; then
          npm_prefix="$(readlink -f "${npm_prefix}" 2>/dev/null || true)"
        fi
        if [ -z "${npm_prefix}" ] && ccq_command_exists realpath; then
          npm_prefix="$(realpath "${npm_prefix}" 2>/dev/null || true)"
        fi
        ;;
    esac
  fi

  # 执行 npm outdated 查询
  local npm_args=("outdated" "-g" "--json")
  if [ -n "${npm_prefix}" ]; then
    npm_args+=("--prefix" "${npm_prefix}")
  fi

  local outdated_json
  outdated_json="$(npm "${npm_args[@]}" 2>/dev/null || true)"

  # 解析 JSON 转 TSV 格式: <package_name><TAB><current><TAB><latest>
  local tsv_output=""
  if [ -n "${outdated_json}" ]; then
    tsv_output="$(node -e "
      try {
        const data = JSON.parse(process.argv[1]);
        const lines = [];
        for (const [pkg, info] of Object.entries(data)) {
          const current = info.current || '';
          const latest = info.latest || '';
          lines.push(\`\${pkg}\t\${current}\t\${latest}\`);
        }
        console.log(lines.join('\\n'));
      } catch (e) {
        // JSON 解析失败返回空
      }
    " "${outdated_json}" 2>/dev/null || true)"
  fi

  # 更新缓存
  CCQ_NPM_OUTDATED_CACHE="${tsv_output}"
  CCQ_NPM_OUTDATED_CACHED=1

  printf '%s' "${tsv_output}"
}

# ============ Unified Test Framework ============

# 会话级测试结果缓存
typeset -gA CCQ_TEST_RESULT_CACHE

ccq_get_cached_test_result() {
  local cache_key="${1:-}"
  local ttl_seconds="${2:-30}"
  [ -z "${cache_key}" ] && return 1

  local cache_entry="${CCQ_TEST_RESULT_CACHE[${cache_key}]:-}"
  [ -z "${cache_entry}" ] && return 1

  local created_at="${cache_entry%%:*}"
  local now="$(date +%s)"
  local elapsed=$((now - created_at))

  [ ${elapsed} -le ${ttl_seconds} ] || { unset "CCQ_TEST_RESULT_CACHE[${cache_key}]"; return 1; }

  printf '%s\n' "${cache_entry#*:}"
}

ccq_set_cached_test_result() {
  local cache_key="${1:-}"
  local result="${2:-}"
  [ -z "${cache_key}" ] && return 1

  local now="$(date +%s)"
  CCQ_TEST_RESULT_CACHE[${cache_key}]="${now}:${result}"
}

ccq_clear_test_cache() {
  local step_id="${1:-}"
  if [ -z "${step_id}" ]; then
    CCQ_TEST_RESULT_CACHE=()
  else
    unset "CCQ_TEST_RESULT_CACHE[${step_id}]"
  fi
}

ccq_resolve_json_path() {
  local json="${1:-}"
  local path="${2:-}"
  [ -z "${json}" ] || [ -z "${path}" ] && return 1

  node -e "
    try {
      const data = JSON.parse(process.argv[1]);
      const segments = process.argv[2].split('.');
      let current = data;
      for (const seg of segments) {
        if (current == null) { process.exit(1); }
        current = current[seg];
      }
      if (current != null) { console.log(current); }
    } catch (e) { process.exit(1); }
  " "${json}" "${path}" 2>/dev/null
}

ccq_test_path_structure() {
  local checks_json="${1:-}"
  [ -z "${checks_json}" ] && { printf '{"allPassed":false,"details":[]}'; return 0; }

  local all_passed=1
  local details="[]"

  details="$(node -e "
    const checks = JSON.parse(process.argv[1]);
    const fs = require('fs');
    const path = require('path');
    const details = [];
    let allPassed = true;

    for (const check of checks) {
      let passed = false;
      let info = '';

      if (check.type === 'dir') {
        passed = fs.existsSync(check.path) && fs.statSync(check.path).isDirectory();
        if (passed && check.filter && check.minCount !== undefined) {
          const files = fs.readdirSync(check.path).filter(f => f.includes(check.filter));
          passed = files.length >= check.minCount;
          info = \`found \${files.length}/\${check.minCount}\`;
        }
      } else if (check.type === 'file') {
        passed = fs.existsSync(check.path) && fs.statSync(check.path).isFile();
        if (passed && check.contentMatch) {
          const content = fs.readFileSync(check.path, 'utf8');
          passed = new RegExp(check.contentMatch).test(content);
          if (!passed) info = 'content mismatch';
        }
      }

      if (!passed) allPassed = false;
      details.push({ path: check.path, passed, info });
    }

    console.log(JSON.stringify({ allPassed, details }));
  " "${checks_json}" 2>/dev/null || printf '{"allPassed":false,"details":[]}')"

  printf '%s' "${details}"
}

ccq_test_json_config() {
  local file_path="${1:-}"
  local required_fields_json="${2:-[]}"
  local required_array_items_json="${3:-[]}"
  [ ! -f "${file_path}" ] && { printf '{"allPassed":false,"missingFields":[],"parseError":"file not found"}'; return 0; }

  local result
  result="$(node -e "
    const fs = require('fs');
    const filePath = process.argv[1];
    const requiredFields = JSON.parse(process.argv[2]);
    const requiredArrayItems = JSON.parse(process.argv[3]);

    let json, parseError = '';
    try {
      json = JSON.parse(fs.readFileSync(filePath, 'utf8'));
    } catch (e) {
      console.log(JSON.stringify({ allPassed: false, missingFields: [], parseError: 'JSON parse failed: ' + e.message }));
      process.exit(0);
    }

    const resolveJsonPath = (obj, path) => {
      const segments = path.split('.');
      let current = obj;
      for (const seg of segments) {
        if (current == null) return null;
        current = current[seg];
      }
      return current;
    };

    let allPassed = true;
    const missingFields = [];

    for (const field of requiredFields) {
      const value = resolveJsonPath(json, field.path);
      const mode = field.matchMode || 'Exists';
      let passed = false;

      if (mode === 'Exists') {
        passed = value != null && value !== '';
      } else if (mode === 'Exact') {
        passed = String(value) === String(field.expectedValue || '');
      } else if (mode === 'Contains') {
        passed = String(value).includes(String(field.expectedValue || ''));
      }

      if (!passed) {
        allPassed = false;
        missingFields.push(field.path);
      }
    }

    for (const arrayCheck of requiredArrayItems) {
      const array = resolveJsonPath(json, arrayCheck.path);
      if (!Array.isArray(array)) {
        allPassed = false;
        missingFields.push(arrayCheck.path);
        continue;
      }
      for (const item of arrayCheck.items) {
        if (!array.includes(item)) {
          allPassed = false;
          missingFields.push(\`\${arrayCheck.path}::\${item}\`);
        }
      }
    }

    console.log(JSON.stringify({ allPassed, missingFields, parsedJson: json }));
  " "${file_path}" "${required_fields_json}" "${required_array_items_json}" 2>/dev/null || printf '{"allPassed":false,"missingFields":[],"parseError":"node execution failed"}')"

  printf '%s' "${result}"
}

ccq_invoke_unified_check() {
  local step_id="${1:-}"; shift || true
  local display_name="${step_id}"
  local command="" min_version="" path_checks_json="[]" config_file=""
  local required_fields_json="[]" required_array_items_json="[]"
  local custom_verify="" use_cache=0 quiet=0

  while [ $# -gt 0 ]; do
    case "$1" in
      --display-name) display_name="$2"; shift 2 ;;
      --command) command="$2"; shift 2 ;;
      --min-version) min_version="$2"; shift 2 ;;
      --path-checks) path_checks_json="$2"; shift 2 ;;
      --config-file) config_file="$2"; shift 2 ;;
      --required-fields) required_fields_json="$2"; shift 2 ;;
      --required-array-items) required_array_items_json="$2"; shift 2 ;;
      --custom-verify) custom_verify="$2"; shift 2 ;;
      --use-cache) use_cache=1; shift ;;
      --quiet) quiet=1; shift ;;
      *) shift ;;
    esac
  done

  # 缓存检查
  if [ ${use_cache} -eq 1 ]; then
    local cached
    cached="$(ccq_get_cached_test_result "${step_id}" 30 2>/dev/null || true)"
    if [ -n "${cached}" ]; then
      printf '%s\n' "${cached}"
      return 0
    fi
  fi

  local is_installed=0 version="" message="${display_name} 未安装"

  # CLI 命令检测
  if [ -n "${command}" ]; then
    if ccq_command_exists "${command}"; then
      is_installed=1
      version="$(ccq_get_command_version "${command}" 2>/dev/null || true)"
      message="${display_name} 已安装"

      # 版本比较（简化逻辑：仅比较主版本号）
      if [ -n "${min_version}" ] && [ -n "${version}" ]; then
        local current_major="${version%%.*}"
        local required_major="${min_version%%.*}"
        if [ "${current_major}" -lt "${required_major}" ] 2>/dev/null; then
          is_installed=0
          message="${display_name} 版本过低 (当前: ${version}, 需要: ${min_version}+)"
        fi
      fi
    else
      is_installed=0
      message="${display_name} 命令不存在"
    fi

    [ ${is_installed} -eq 0 ] && {
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    }
  fi

  # 目录结构检测
  if [ "${path_checks_json}" != "[]" ]; then
    local path_result
    path_result="$(ccq_test_path_structure "${path_checks_json}")"
    local all_passed
    all_passed="$(printf '%s' "${path_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).allPassed' 2>/dev/null || echo false)"

    if [ "${all_passed}" != "true" ]; then
      is_installed=0
      message="${display_name} 目录结构不完整"
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    fi
  fi

  # 配置文件检测
  if [ -n "${config_file}" ]; then
    local config_result
    config_result="$(ccq_test_json_config "${config_file}" "${required_fields_json}" "${required_array_items_json}")"
    local parse_error
    parse_error="$(printf '%s' "${config_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).parseError || ""' 2>/dev/null || true)"

    if [ -n "${parse_error}" ]; then
      is_installed=0
      message="${display_name} 配置解析失败: ${parse_error}"
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    fi

    local all_passed
    all_passed="$(printf '%s' "${config_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).allPassed' 2>/dev/null || echo false)"

    if [ "${all_passed}" != "true" ]; then
      is_installed=0
      local missing_fields
      missing_fields="$(printf '%s' "${config_result}" | node -pe 'JSON.parse(require("fs").readFileSync(0,"utf8")).missingFields.join(", ")' 2>/dev/null || true)"
      message="${display_name} 配置不完整: ${missing_fields}"
      local result="{\"isInstalled\":false,\"version\":\"${version}\",\"message\":\"${message}\"}"
      [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${result}"
      printf '%s\n' "${result}"
      return 0
    fi
  fi

  # 自定义验证
  if [ -n "${custom_verify}" ]; then
    local custom_result
    custom_result="$(eval "${custom_verify}" 2>/dev/null || echo "0")"
    if [ "${custom_result}" = "0" ] || [ "${custom_result}" = "false" ]; then
      is_installed=0
      message="${display_name} 自定义验证未通过"
    elif [ "${custom_result}" != "1" ] && [ "${custom_result}" != "true" ]; then
      version="${custom_result}"
    fi
  fi

  # 全部通过
  [ ${is_installed} -eq 0 ] && is_installed=1
  [ -z "${message}" ] || [ "${message}" = "${display_name} 未安装" ] && message="${display_name} 已安装"

  local final_result="{\"isInstalled\":${is_installed},\"version\":\"${version}\",\"message\":\"${message}\"}"

  # UI 输出
  if [ ${quiet} -eq 0 ]; then
    if [ ${is_installed} -eq 1 ]; then
      local version_suffix=""
      [ -n "${version}" ] && version_suffix=" (版本: ${version})"
      command -v ccq_ui_success >/dev/null 2>&1 && ccq_ui_success "✓ ${display_name} 已安装${version_suffix}"
    else
      command -v ccq_ui_warning >/dev/null 2>&1 && ccq_ui_warning "⚠ ${display_name} [FAIL]: ${message}"
    fi
  fi

  # 写入缓存
  [ ${use_cache} -eq 1 ] && ccq_set_cached_test_result "${step_id}" "${final_result}"

  printf '%s\n' "${final_result}"
}


# ─── 来自: macos/core/Profile.zsh ────────────────────────────────────────

# Profile.zsh - macOS Profile 安全编辑
# 功能: 托管标记块、子段写入、备份、原子替换和重复写入收敛

if [ -n "${CCQ_PROFILE_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_PROFILE_ZSH_LOADED=1

CCQ_MANAGED_BLOCK_START="# >>> Claude Code Quickstart >>>"
CCQ_MANAGED_BLOCK_END="# <<< Claude Code Quickstart <<<"
: "${CCQ_BACKUP_DIR:=${TMPDIR:-/tmp}/ccq-backups}"

# ── 契约加载（contracts-first + inline fallback）──

ccq_cleanup_policy_contracts_root() {
  local installer_root="${CCQ_INSTALLER_ROOT:-}"
  if [ -z "${installer_root}" ]; then
    installer_root="$(cd "${0:A:h}/../.." 2>/dev/null && pwd)"
  fi
  [ -d "${installer_root}/contracts" ] && printf '%s\n' "${installer_root}/contracts"
}

ccq_cleanup_policy_contract_path() {
  if [ -n "${CCQ_CLEANUP_POLICY_CONTRACT:-}" ]; then
    printf '%s\n' "${CCQ_CLEANUP_POLICY_CONTRACT}"
    return 0
  fi
  local contracts_root
  contracts_root="$(ccq_cleanup_policy_contracts_root)"
  [ -n "${contracts_root}" ] && printf '%s\n' "${contracts_root}/cleanup-policy.json"
}

ccq_cleanup_policy_contract() {
  local contract_path
  contract_path="$(ccq_cleanup_policy_contract_path)"
  [ -z "${contract_path}" ] || [ ! -f "${contract_path}" ] && return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e '
    const fs = require("fs");
    try {
      const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
      if (c && c.contract) process.stdout.write(JSON.stringify(c.contract));
      else process.exit(1);
    } catch (e) { process.exit(1); }
  ' "${contract_path}" 2>/dev/null
}

ccq_user_home() {
  printf '%s\n' "${HOME}"
}

ccq_ensure_dir() {
  local dir="${1:-}"
  [ -z "${dir}" ] && return 1
  mkdir -p "${dir}"
}

ccq_backup_file() {
  local file_path="${1:-}"
  local reason="${2:-edit}"
  [ -f "${file_path}" ] || return 0
  ccq_ensure_dir "${CCQ_BACKUP_DIR}"
  local base timestamp backup_path
  base="$(basename "${file_path}")"
  timestamp="$(date '+%Y%m%d_%H%M%S')"
  backup_path="${CCQ_BACKUP_DIR}/${base}.${reason}.${timestamp}.bak"
  cp "${file_path}" "${backup_path}"
  printf '%s\n' "${backup_path}"
}

ccq_write_file_atomic() {
  local file_path="${1:-}"
  local content="${2:-}"
  local dir temp_path
  [ -z "${file_path}" ] && return 1
  dir="$(dirname "${file_path}")"
  ccq_ensure_dir "${dir}"
  temp_path="$(mktemp "${dir}/.ccq.tmp.XXXXXX")" || return 1
  printf '%s' "${content}" >"${temp_path}"
  mv "${temp_path}" "${file_path}"
}

ccq_get_managed_block_content() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || return 1

  awk -v start="${CCQ_MANAGED_BLOCK_START}" -v end="${CCQ_MANAGED_BLOCK_END}" '
    $0 == start { in_block = 1; found = 1; next }
    $0 == end { in_block = 0; next }
    in_block { print }
    END { if (!found) exit 1 }
  ' "${file_path}"
}

ccq_remove_managed_block_stream() {
  local file_path="${1:-}"
  if [ ! -f "${file_path}" ]; then
    return 0
  fi

  awk -v start="${CCQ_MANAGED_BLOCK_START}" -v end="${CCQ_MANAGED_BLOCK_END}" '
    $0 == start { in_block = 1; next }
    $0 == end { in_block = 0; next }
    !in_block { print }
  ' "${file_path}"
}

ccq_set_managed_block_in_file() {
  local file_path="${1:-}"
  local block_content="${2:-}"
  local existing_without_block new_content trimmed_existing

  [ -z "${file_path}" ] && return 1
  existing_without_block="$(ccq_remove_managed_block_stream "${file_path}" 2>/dev/null || true)"
  trimmed_existing="${existing_without_block%$'\n'}"

  if [ -n "${trimmed_existing}" ]; then
    new_content="${trimmed_existing}

${CCQ_MANAGED_BLOCK_START}
${block_content%$'\n'}
${CCQ_MANAGED_BLOCK_END}
"
  else
    new_content="${CCQ_MANAGED_BLOCK_START}
${block_content%$'\n'}
${CCQ_MANAGED_BLOCK_END}
"
  fi

  if [ -f "${file_path}" ]; then
    local current
    current="$(cat "${file_path}")"
    if [ "${current%$'\n'}" = "${new_content%$'\n'}" ]; then
      return 0
    fi
    ccq_backup_file "${file_path}" "managed_block" >/dev/null || true
  fi

  ccq_write_file_atomic "${file_path}" "${new_content}"
}

ccq_remove_managed_block_from_file() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || return 0
  local new_content
  new_content="$(ccq_remove_managed_block_stream "${file_path}")"
  ccq_backup_file "${file_path}" "remove_managed_block" >/dev/null || true
  ccq_write_file_atomic "${file_path}" "${new_content%$'\n'}
"
}

ccq_zprofile_path() { printf '%s\n' "${HOME}/.zprofile"; }
ccq_zshrc_path() { printf '%s\n' "${HOME}/.zshrc"; }

# ============ Update Manifest 管理 ============

ccq_update_manifest_path() {
  printf '%s/.ccq/update-manifest.json\n' "${HOME}"
}

ccq_read_update_manifest() {
  local manifest_path
  manifest_path="$(ccq_update_manifest_path)"

  if [ ! -f "${manifest_path}" ]; then
    printf '{"schemaVersion":1,"steps":{}}\n'
    return 0
  fi

  cat "${manifest_path}"
}

ccq_write_update_manifest() {
  local content="${1:-}"
  local manifest_path
  manifest_path="$(ccq_update_manifest_path)"

  ccq_ensure_dir "$(dirname "${manifest_path}")"

  # 自动追加 updatedAt 时间戳
  local updated_content
  updated_content="$(node -e "
    const data = JSON.parse(process.argv[1]);
    data.updatedAt = new Date().toISOString();
    console.log(JSON.stringify(data, null, 2));
  " "${content}" 2>/dev/null || printf '%s' "${content}")"

  ccq_write_file_atomic "${manifest_path}" "${updated_content}"
}

# ============ Update Snapshot 管理 ============

ccq_create_update_snapshot() {
  local snapshot_base="${TMPDIR:-/tmp}/ccq-backups"
  local timestamp pid rand8 snapshot_dir

  timestamp="$(date '+%Y%m%d_%H%M%S')"
  pid="$$"
  rand8="$(openssl rand -hex 4 2>/dev/null || printf '%08x' $RANDOM$RANDOM)"
  snapshot_dir="${snapshot_base}/update_${timestamp}_${pid}_${rand8}"

  ccq_ensure_dir "${snapshot_dir}" || return 1

  # 备份文件列表
  local files_to_backup=(
    "${HOME}/.claude/settings.json"
    "${HOME}/.claude.json"
    "${HOME}/.claude/CLAUDE.md"
    "${HOME}/.ccq/mcp-meta.json"
  )

  local created_at files_array=()
  created_at="$(date -u '+%Y-%m-%dT%H:%M:%SZ')"

  # 备份每个文件
  for source_file in "${files_to_backup[@]}"; do
    if [ -f "${source_file}" ]; then
      local relative_path hash file_timestamp backup_dest
      relative_path="${source_file#${HOME}/}"
      backup_dest="${snapshot_dir}/${relative_path}"

      ccq_ensure_dir "$(dirname "${backup_dest}")"
      cp "${source_file}" "${backup_dest}" 2>/dev/null || continue

      hash="$(ccq_string_fingerprint "$(cat "${source_file}" 2>/dev/null || true)")"
      file_timestamp="$(date -r "$(stat -f %m "${source_file}" 2>/dev/null || echo 0)" -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo "${created_at}")"

      files_array+=("{\"source\":\"${source_file}\",\"relative\":\"${relative_path}\",\"hash\":\"${hash}\",\"timestamp\":\"${file_timestamp}\"}")
    fi
  done

  # 备份 ccq-*.md 和 ccg-*.md rules
  for rules_pattern in "${HOME}/.claude/rules/ccq-"*.md "${HOME}/.claude/rules/ccg-"*.md; do
    if [ -f "${rules_pattern}" ]; then
      local relative_path hash file_timestamp backup_dest
      relative_path="${rules_pattern#${HOME}/}"
      backup_dest="${snapshot_dir}/${relative_path}"

      ccq_ensure_dir "$(dirname "${backup_dest}")"
      cp "${rules_pattern}" "${backup_dest}" 2>/dev/null || continue

      hash="$(ccq_string_fingerprint "$(cat "${rules_pattern}" 2>/dev/null || true)")"
      file_timestamp="$(date -r "$(stat -f %m "${rules_pattern}" 2>/dev/null || echo 0)" -u '+%Y-%m-%dT%H:%M:%SZ' 2>/dev/null || echo "${created_at}")"

      files_array+=("{\"source\":\"${rules_pattern}\",\"relative\":\"${relative_path}\",\"hash\":\"${hash}\",\"timestamp\":\"${file_timestamp}\"}")
    fi
  done

  # 生成 manifest.json
  local manifest_content
  manifest_content="$(printf '{"createdAt":"%s","files":[%s]}' "${created_at}" "$(IFS=,; printf '%s' "${files_array[*]}")")"

  printf '%s' "${manifest_content}" | node -e "
    const data = JSON.parse(require('fs').readFileSync(0, 'utf8'));
    console.log(JSON.stringify(data, null, 2));
  " > "${snapshot_dir}/manifest.json" 2>/dev/null || true

  printf '%s\n' "${snapshot_dir}"
}

ccq_cleanup_old_snapshots() {
  local current_snapshot="${1:-}"
  local snapshot_base="${CCQ_BACKUP_DIR}"

  [ ! -d "${snapshot_base}" ] && return 0

  # 从契约读取策略参数（contracts-first）
  local contract max_snapshots=5 max_age_days=30 recent_minutes_skip=5
  contract="$(ccq_cleanup_policy_contract 2>/dev/null)"
  if [ -n "${contract}" ] && command -v node >/dev/null 2>&1; then
    max_snapshots=$(printf '%s\n' "${contract}" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(c.maxSnapshots||5);' 2>/dev/null || echo 5)
    max_age_days=$(printf '%s\n' "${contract}" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(c.maxAgeInDays||30);' 2>/dev/null || echo 30)
    recent_minutes_skip=$(printf '%s\n' "${contract}" | node -e 'const c=JSON.parse(require("fs").readFileSync(0,"utf8")); console.log(c.recentMinutesSkip||5);' 2>/dev/null || echo 5)
  fi

  local snapshots=()
  local now_epoch cutoff_epoch recent_cutoff_epoch
  now_epoch="$(date '+%s')"
  cutoff_epoch=$((now_epoch - max_age_days * 86400))
  recent_cutoff_epoch=$((now_epoch - recent_minutes_skip * 60))

  # 收集所有 snapshot 目录
  for snapshot_dir in "${snapshot_base}"/update_*; do
    [ ! -d "${snapshot_dir}" ] && continue
    [ "${snapshot_dir}" = "${current_snapshot}" ] && continue

    local dir_mtime
    dir_mtime="$(stat -f '%m' "${snapshot_dir}" 2>/dev/null || echo 0)"

    # 跳过最近 N 分钟内创建的目录
    if [ "${dir_mtime}" -gt "${recent_cutoff_epoch}" ]; then
      continue
    fi

    # 删除超过 N 天的
    if [ "${dir_mtime}" -lt "${cutoff_epoch}" ]; then
      rm -rf "${snapshot_dir}" 2>/dev/null || true
      continue
    fi

    snapshots+=("${dir_mtime}:${snapshot_dir}")
  done

  # 保留最新 N 个
  if [ "${#snapshots[@]}" -gt "${max_snapshots}" ]; then
    local sorted_snapshots
    sorted_snapshots=($(printf '%s\n' "${snapshots[@]}" | sort -rn))

    local i=0
    for entry in "${sorted_snapshots[@]}"; do
      i=$((i + 1))
      if [ "${i}" -gt "${max_snapshots}" ]; then
        local snapshot_path="${entry#*:}"
        rm -rf "${snapshot_path}" 2>/dev/null || true
      fi
    done
  fi
}

# ============ SHA-256 指纹计算 ============

ccq_string_fingerprint() {
  local input="${1:-}"
  local hash=""

  # 优先使用 shasum
  if command -v shasum >/dev/null 2>&1; then
    hash="$(printf '%s' "${input}" | shasum -a 256 | awk '{print $1}')"
  elif command -v openssl >/dev/null 2>&1; then
    hash="$(printf '%s' "${input}" | openssl dgst -sha256 | awk '{print $NF}')"
  else
    return 1
  fi

  printf '%s\n' "${hash}"
}

# ============ 备份清理 ============

ccq_cleanup_old_backups() {
  local max_days="${1:-7}"
  local max_count="${2:-5}"

  [ ! -d "${CCQ_BACKUP_DIR}" ] && return 0

  local now_epoch cutoff_epoch
  now_epoch="$(date '+%s')"
  cutoff_epoch=$((now_epoch - max_days * 86400))

  # 按文件基名分组
  local base_files=()
  for backup_file in "${CCQ_BACKUP_DIR}"/*.bak; do
    [ ! -f "${backup_file}" ] && continue

    local file_mtime base_name
    file_mtime="$(stat -f '%m' "${backup_file}" 2>/dev/null || echo 0)"
    base_name="$(basename "${backup_file}" | sed 's/\.[^.]*\.[0-9_]*\.bak$//')"

    # 删除超过 max_days 天的
    if [ "${file_mtime}" -lt "${cutoff_epoch}" ]; then
      rm -f "${backup_file}" 2>/dev/null || true
      continue
    fi

    base_files+=("${file_mtime}:${base_name}:${backup_file}")
  done

  # 按基名分组，保留每组最新 max_count 个
  local processed_bases=()
  for entry in $(printf '%s\n' "${base_files[@]}" | sort -t: -k2,2 -k1,1rn); do
    local base_name="${entry#*:}"; base_name="${base_name%:*}"
    local backup_file="${entry##*:}"

    # 统计该 base_name 已保留的数量
    local count=0
    for pb in "${processed_bases[@]}"; do
      [ "${pb}" = "${base_name}" ] && count=$((count + 1))
    done

    if [ "${count}" -ge "${max_count}" ]; then
      rm -f "${backup_file}" 2>/dev/null || true
    else
      processed_bases+=("${base_name}")
    fi
  done
}


# ─── 来自: macos/core/Platform.zsh ────────────────────────────────────────

# Platform.zsh - macOS 平台能力检测
# 功能: macOS 版本、架构、zsh、HOME、PATH 分隔符和可执行解析能力检测

if [ -n "${CCQ_PLATFORM_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_PLATFORM_ZSH_LOADED=1

ccq_is_macos() {
  [ "$(uname -s 2>/dev/null)" = "Darwin" ]
}

ccq_macos_version() {
  sw_vers -productVersion 2>/dev/null || true
}

ccq_version_major() {
  local version="${1:-}"
  printf '%s' "${version%%.*}"
}

ccq_compare_versions_ge() {
  local actual="${1:-0}"
  local required="${2:-0}"
  local actual_major required_major
  actual_major="$(ccq_version_major "${actual}")"
  required_major="$(ccq_version_major "${required}")"
  [ "${actual_major:-0}" -ge "${required_major:-0}" ]
}

ccq_assert_macos_supported() {
  local min_version="${1:-12}"
  if ! ccq_is_macos; then
    CCQ_LAST_PLATFORM_ERROR="当前系统不是 macOS"
    return 1
  fi
  local version
  version="$(ccq_macos_version)"
  if [ -z "${version}" ] || ! ccq_compare_versions_ge "${version}" "${min_version}"; then
    CCQ_LAST_PLATFORM_ERROR="macOS 版本过低: ${version:-unknown}，需要 ${min_version}+"
    return 1
  fi
  return 0
}

ccq_arch() {
  uname -m 2>/dev/null || true
}

ccq_is_apple_silicon() {
  [ "$(ccq_arch)" = "arm64" ]
}

ccq_default_brew_prefix() {
  if ccq_is_apple_silicon; then
    printf '%s\n' '/opt/homebrew'
  else
    printf '%s\n' '/usr/local'
  fi
}

ccq_current_shell() {
  printf '%s\n' "${SHELL:-}"
}

ccq_is_zsh_shell() {
  case "$(basename "${SHELL:-}")" in
    zsh) return 0 ;;
    *) return 1 ;;
  esac
}

ccq_home_dir() {
  printf '%s\n' "${HOME}"
}

ccq_path_separator() {
  printf ':'
}

ccq_executable_suffix() {
  printf ''
}

ccq_resolve_executable() {
  command -v "$1" 2>/dev/null || true
}

ccq_platform_summary() {
  printf 'os=macOS\n'
  printf 'version=%s\n' "$(ccq_macos_version)"
  printf 'arch=%s\n' "$(ccq_arch)"
  printf 'shell=%s\n' "$(ccq_current_shell)"
  printf 'home=%s\n' "$(ccq_home_dir)"
  printf 'pathSeparator=:\n'
  printf 'executableSuffix=\n'
}


# ─── 来自: macos/core/PackageManager.zsh ────────────────────────────────────────

# PackageManager.zsh - macOS Homebrew 包管理器封装
# 功能: Homebrew 检测、官方安装、prefix 识别、shellenv 初始化、formula/cask 安装与升级包装

if [ -n "${CCQ_PACKAGE_MANAGER_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_PACKAGE_MANAGER_ZSH_LOADED=1

ccq_brew_command() {
  if command -v brew >/dev/null 2>&1; then
    command -v brew
    return 0
  fi

  local prefix
  if command -v ccq_default_brew_prefix >/dev/null 2>&1; then
    prefix="$(ccq_default_brew_prefix)"
  else
    prefix="/opt/homebrew"
  fi

  if [ -x "${prefix}/bin/brew" ]; then
    printf '%s\n' "${prefix}/bin/brew"
    return 0
  fi
  if [ -x "/usr/local/bin/brew" ]; then
    printf '%s\n' "/usr/local/bin/brew"
    return 0
  fi
  return 1
}

ccq_brew_available() {
  ccq_brew_command >/dev/null 2>&1
}

ccq_homebrew_install_command() {
  printf '%s\n' '/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty'
}

ccq_install_homebrew() {
  if ccq_brew_available; then
    return 0
  fi
  if [ ! -r /dev/tty ]; then
    return 1
  fi
  /bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)" < /dev/tty
}

ccq_brew_prefix() {
  local brew_bin
  brew_bin="$(ccq_brew_command 2>/dev/null || true)"
  if [ -n "${brew_bin}" ]; then
    "${brew_bin}" --prefix 2>/dev/null || dirname "$(dirname "${brew_bin}")"
    return 0
  fi
  if command -v ccq_default_brew_prefix >/dev/null 2>&1; then
    ccq_default_brew_prefix
  else
    printf '%s\n' '/opt/homebrew'
  fi
}

ccq_brew_shellenv() {
  local brew_bin
  brew_bin="$(ccq_brew_command 2>/dev/null || true)"
  if [ -z "${brew_bin}" ]; then
    return 1
  fi
  "${brew_bin}" shellenv
}

ccq_homebrew_shellenv_line() {
  local brew_bin="${1:-}"
  [ -n "${brew_bin}" ] || brew_bin="$(ccq_brew_command 2>/dev/null || true)"
  [ -n "${brew_bin}" ] || return 1
  printf 'eval "$(%s shellenv)"\n' "${brew_bin}"
}

ccq_apply_homebrew_post_install_steps() {
  local profile_path="${1:-${HOME}/.zprofile}"
  local brew_bin shellenv_line
  brew_bin="$(ccq_brew_command 2>/dev/null || true)"
  [ -n "${brew_bin}" ] || return 1
  shellenv_line="$(ccq_homebrew_shellenv_line "${brew_bin}")" || return 1

  if [ ! -f "${profile_path}" ] || ! grep -F -- "${shellenv_line}" "${profile_path}" >/dev/null 2>&1; then
    {
      printf '\n'
      printf '%s\n' "${shellenv_line}"
    } >>"${profile_path}"
  fi

  eval "$("${brew_bin}" shellenv)"
}

ccq_brew_install_formula() {
  local formula="${1:-}"
  [ -z "${formula}" ] && return 1
  local brew_bin
  brew_bin="$(ccq_brew_command)" || return 1

  if "${brew_bin}" list --formula "${formula}" >/dev/null 2>&1; then
    return 0
  fi
  ccq_run_native_command "${brew_bin}" install "${formula}"
}

ccq_brew_install_cask() {
  local cask="${1:-}"
  [ -z "${cask}" ] && return 1
  local brew_bin
  brew_bin="$(ccq_brew_command)" || return 1

  if "${brew_bin}" list --cask "${cask}" >/dev/null 2>&1; then
    return 0
  fi
  ccq_run_native_command "${brew_bin}" install --cask "${cask}"
}

ccq_brew_upgrade_package() {
  local package_name="${1:-}"
  local kind="${2:-formula}"
  [ -z "${package_name}" ] && return 1
  local brew_bin
  brew_bin="$(ccq_brew_command)" || return 1

  case "${kind}" in
    cask) ccq_run_native_command "${brew_bin}" upgrade --cask "${package_name}" ;;
    formula|*) ccq_run_native_command "${brew_bin}" upgrade "${package_name}" ;;
  esac
}

ccq_homebrew_install_hint() {
  cat <<'EOF'
Homebrew 未安装。可按 Homebrew 官方方式安装：
/bin/bash -c "$(curl -fsSL https://raw.githubusercontent.com/Homebrew/install/HEAD/install.sh)"
安装完成后重新运行 CCQ。
EOF
}


# ─── 来自: macos/core/Json.zsh ────────────────────────────────────────

# Json.zsh - macOS JSON 读写助手
# 功能: Node.js helper 进行 JSON 读取、合并、数组去重、敏感字段掩码和原子写入；plutil 作为早期兜底

if [ -n "${CCQ_JSON_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_JSON_ZSH_LOADED=1

ccq_json_validate() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || return 1
  if command -v node >/dev/null 2>&1; then
    node -e 'const fs=require("fs"); JSON.parse(fs.readFileSync(process.argv[1],"utf8"));' "${file_path}" >/dev/null
    return $?
  fi
  if command -v plutil >/dev/null 2>&1; then
    plutil -lint "${file_path}" >/dev/null
    return $?
  fi
  return 1
}

ccq_json_read() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || { printf '{}\n'; return 0; }
  ccq_json_validate "${file_path}" || return 1
  cat "${file_path}"
}

ccq_json_write_atomic() {
  local file_path="${1:-}"
  local json_content="${2}"
  [ -z "${json_content}" ] && json_content="{}"
  local dir temp_path
  [ -z "${file_path}" ] && return 1
  dir="$(dirname "${file_path}")"
  mkdir -p "${dir}"

  temp_path="$(mktemp "${dir}/.ccq-json.XXXXXX")" || return 1
  printf '%s' "${json_content}" >"${temp_path}"
  ccq_json_validate "${temp_path}" || { rm -f "${temp_path}"; return 1; }
  mv "${temp_path}" "${file_path}"
}

ccq_json_merge_file() {
  local file_path="${1:-}"
  local patch_json="${2}"
  [ -z "${patch_json}" ] && patch_json="{}"
  [ -z "${file_path}" ] && return 1

  if ! command -v node >/dev/null 2>&1; then
    CCQ_LAST_JSON_ERROR="Node.js 不可用，无法执行复杂 JSON merge"
    return 1
  fi

  local merged
  merged="$(node -e '
const fs = require("fs");
const target = process.argv[1];
const patch = JSON.parse(process.argv[2] || "{}");
function isObject(v) { return v && typeof v === "object" && !Array.isArray(v); }
function merge(a, b) {
  const out = isObject(a) ? {...a} : {};
  for (const [key, value] of Object.entries(b)) {
    if (value === null) { delete out[key]; continue; }
    if (Array.isArray(value)) {
      const current = Array.isArray(out[key]) ? out[key] : [];
      out[key] = [...new Set([...current, ...value])];
      continue;
    }
    if (isObject(value)) { out[key] = merge(out[key], value); continue; }
    out[key] = value;
  }
  return out;
}
let base = {};
if (fs.existsSync(target)) {
  const raw = fs.readFileSync(target, "utf8").trim();
  if (raw) base = JSON.parse(raw);
}
process.stdout.write(JSON.stringify(merge(base, patch), null, 2) + "\n");
' "${file_path}" "${patch_json}")" || return 1

  ccq_json_write_atomic "${file_path}" "${merged}"
}

ccq_json_get() {
  local file_path="${1:-}"
  local path_expr="${2:-}"
  [ -z "${file_path}" ] || [ -z "${path_expr}" ] && return 1
  command -v node >/dev/null 2>&1 || return 1
  node -e '
const fs = require("fs");
const target = process.argv[1];
const path = process.argv[2].split(".").filter(Boolean);
let value = {};
if (fs.existsSync(target)) value = JSON.parse(fs.readFileSync(target, "utf8") || "{}");
for (const key of path) {
  if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) process.exit(1);
  value = value[key];
}
if (typeof value === "object") process.stdout.write(JSON.stringify(value));
else process.stdout.write(String(value));
' "${file_path}" "${path_expr}"
}

ccq_mask_secret_value() {
  local value="${1:-}"
  local length="${#value}"
  if [ "${length}" -eq 0 ]; then
    printf '-'
  elif [ "${length}" -le 8 ]; then
    printf '***'
  else
    printf '%s...%s' "${value:0:4}" "${value: -2}"
  fi
}

ccq_json_mask_sensitive() {
  command -v node >/dev/null 2>&1 || { cat; return 0; }
  node -e '
const fs = require("fs");
const secretPattern = /(token|key|secret|password|credential)/i;
function mask(v) {
  if (Array.isArray(v)) return v.map(mask);
  if (v && typeof v === "object") {
    const out = {};
    for (const [k, val] of Object.entries(v)) out[k] = secretPattern.test(k) ? "***" : mask(val);
    return out;
  }
  return v;
}
const input = fs.readFileSync(0, "utf8");
process.stdout.write(JSON.stringify(mask(JSON.parse(input || "{}")), null, 2) + "\n");
'
}

ccq_json_ensure_object_file() {
  local file_path="${1:-}"
  [ -z "${file_path}" ] && return 1
  if [ -f "${file_path}" ]; then
    ccq_json_validate "${file_path}"
    return $?
  fi
  ccq_json_write_atomic "${file_path}" '{}
'
}


# ─── 来自: macos/core/Registry.zsh ────────────────────────────────────────

# Registry.zsh - macOS 步骤注册表
# 功能: 从 contracts steps 契约加载步骤、分组、依赖与更新函数；Node.js 不可用时使用启动快照完成 NodeJS 前置阶段

if [ -n "${CCQ_REGISTRY_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_REGISTRY_ZSH_LOADED=1

: "${CCQ_INSTALLER_ROOT:=$(cd "${0:A:h}/../.." 2>/dev/null && pwd)}"
# installer 契约位于 installer/contracts/（TDR-10 拆分：steps/build/cleanup-policy 归 installer）
: "${CCQ_CONTRACTS_DIR:=${CCQ_INSTALLER_ROOT}/contracts}"
CCQ_STEPS_CONTRACT="${CCQ_CONTRACTS_DIR}/steps.json"

typeset -ga CCQ_BOOTSTRAP_STEP_IDS
typeset -gA CCQ_BOOTSTRAP_STEP_NAME
typeset -gA CCQ_BOOTSTRAP_STEP_DESCRIPTION
typeset -gA CCQ_BOOTSTRAP_STEP_FILE
typeset -gA CCQ_BOOTSTRAP_STEP_TEST
typeset -gA CCQ_BOOTSTRAP_STEP_INSTALL
typeset -gA CCQ_BOOTSTRAP_STEP_VERIFY
typeset -gA CCQ_BOOTSTRAP_STEP_UPDATE
typeset -gA CCQ_BOOTSTRAP_STEP_SKIP
typeset -gA CCQ_BOOTSTRAP_STEP_OPTIONAL
typeset -gA CCQ_BOOTSTRAP_STEP_ORDER
typeset -gA CCQ_BOOTSTRAP_STEP_DEPS
typeset -ga CCQ_BOOTSTRAP_GROUP_BASIC

ccq_registry_init_bootstrap_snapshot() {
  [ "${#CCQ_BOOTSTRAP_STEP_IDS[@]}" -gt 0 ] && return 0

  CCQ_BOOTSTRAP_GROUP_BASIC=(NodeJS Git)
  CCQ_BOOTSTRAP_STEP_IDS=(NodeJS Git)

  CCQ_BOOTSTRAP_STEP_NAME[NodeJS]="Node.js"
  CCQ_BOOTSTRAP_STEP_NAME[Git]="Git"

  CCQ_BOOTSTRAP_STEP_DESCRIPTION[NodeJS]="现有 node/npm 版本达标则跳过，否则优先通过当前 fnm/nvm 安装 LTS，无法原地修复时通过 nvm 官方脚本兜底"
  CCQ_BOOTSTRAP_STEP_DESCRIPTION[Git]="通过 Homebrew 安装 Git 并应用推荐配置"

  local step_id order=10
  for step_id in "${CCQ_BOOTSTRAP_STEP_IDS[@]}"; do
    CCQ_BOOTSTRAP_STEP_FILE[${step_id}]="macos/steps/${step_id}.zsh"
    CCQ_BOOTSTRAP_STEP_TEST[${step_id}]="Test-${step_id}Installed"
    CCQ_BOOTSTRAP_STEP_INSTALL[${step_id}]="Install-${step_id}"
    CCQ_BOOTSTRAP_STEP_VERIFY[${step_id}]="Verify-${step_id}"
    CCQ_BOOTSTRAP_STEP_UPDATE[${step_id}]=""
    CCQ_BOOTSTRAP_STEP_SKIP[${step_id}]="true"
    CCQ_BOOTSTRAP_STEP_OPTIONAL[${step_id}]="false"
    CCQ_BOOTSTRAP_STEP_ORDER[${step_id}]="${order}"
    CCQ_BOOTSTRAP_STEP_DEPS[${step_id}]=""
    order=$((order + 10))
  done
}

ccq_registry_node() {
  command -v node >/dev/null 2>&1
}

ccq_registry_can_use_contract() {
  ccq_registry_node && [ -f "${CCQ_STEPS_CONTRACT}" ]
}

ccq_registry_require_node() {
  if ! ccq_registry_can_use_contract; then
    printf '%s\n' 'Node.js 不可用，无法读取 contracts/steps.json' >&2
    return 1
  fi
}

ccq_registry_query() {
  local expression="${1:-}"
  ccq_registry_require_node || return 1
  node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const expression = process.argv[2];
const value = Function("contract", `return (${expression});`)(contract);
if (typeof value === "string") process.stdout.write(value + "\n");
else process.stdout.write(JSON.stringify(value, null, 2) + "\n");
' "${CCQ_STEPS_CONTRACT}" "${expression}"
}

ccq_get_step_registry_json() {
  if ccq_registry_can_use_contract; then
    ccq_registry_query 'contract.Steps'
    return $?
  fi
  printf '[]\n'
}

ccq_get_step_groups_json() {
  if ccq_registry_can_use_contract; then
    ccq_registry_query 'contract.Groups'
    return $?
  fi
  printf '{}\n'
}

ccq_get_step_config_json() {
  local step_id="${1:-}"
  [ -z "${step_id}" ] && return 1
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const step = contract.Steps.find(s => s.StepId === process.argv[2]) || null;
process.stdout.write(JSON.stringify(step, null, 2) + "\n");
' "${CCQ_STEPS_CONTRACT}" "${step_id}"
    return $?
  fi
  ccq_registry_init_bootstrap_snapshot
  if [ -z "${CCQ_BOOTSTRAP_STEP_NAME[${step_id}]:-}" ]; then
    return 1
  fi
  printf '{"StepId":"%s","StepName":"%s"}\n' "${step_id}" "${CCQ_BOOTSTRAP_STEP_NAME[${step_id}]}"
}

ccq_get_bootstrap_step_field() {
  local step_id="${1:-}"
  local field="${2:-}"
  ccq_registry_init_bootstrap_snapshot
  case "${field}" in
    StepId) printf '%s' "${step_id}" ;;
    StepName) printf '%s' "${CCQ_BOOTSTRAP_STEP_NAME[${step_id}]:-}" ;;
    Description) printf '%s' "${CCQ_BOOTSTRAP_STEP_DESCRIPTION[${step_id}]:-}" ;;
    StepFile|MacOSStepFile) printf '%s' "${CCQ_BOOTSTRAP_STEP_FILE[${step_id}]:-}" ;;
    TestFunction) printf '%s' "${CCQ_BOOTSTRAP_STEP_TEST[${step_id}]:-}" ;;
    InstallFunction) printf '%s' "${CCQ_BOOTSTRAP_STEP_INSTALL[${step_id}]:-}" ;;
    VerifyFunction) printf '%s' "${CCQ_BOOTSTRAP_STEP_VERIFY[${step_id}]:-}" ;;
    UpdateFunction) printf '%s' "${CCQ_BOOTSTRAP_STEP_UPDATE[${step_id}]:-}" ;;
    SkipIfInstalled) printf '%s' "${CCQ_BOOTSTRAP_STEP_SKIP[${step_id}]:-false}" ;;
    IsOptional) printf '%s' "${CCQ_BOOTSTRAP_STEP_OPTIONAL[${step_id}]:-false}" ;;
    Order) printf '%s' "${CCQ_BOOTSTRAP_STEP_ORDER[${step_id}]:-999}" ;;
    Dependencies)
      local deps_text="${CCQ_BOOTSTRAP_STEP_DEPS[${step_id}]:-}"
      local dep
      for dep in ${deps_text}; do
        printf '%s\n' "${dep}"
      done
      ;;
    Group)
      case "${step_id}" in
        NodeJS|Git) printf 'Basic' ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

ccq_get_step_field() {
  local step_id="${1:-}"
  local field="${2:-}"
  [ -z "${step_id}" ] || [ -z "${field}" ] && return 1
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const step = contract.Steps.find(s => s.StepId === process.argv[2]);
if (!step) process.exit(1);
const field = process.argv[3];
if (field !== "UpdateFunction" && !Object.prototype.hasOwnProperty.call(step, field)) process.exit(1);
let value = field === "UpdateFunction" && step.MacOSUpdateFunction !== undefined
  ? step.MacOSUpdateFunction
  : step[field];
if (field === "SkipIfInstalled" && step.MacOSSkipIfInstalled !== undefined) {
  value = step.MacOSSkipIfInstalled;
}
if (value === undefined) process.exit(1);
if (Array.isArray(value)) process.stdout.write(value.join("\n"));
else process.stdout.write(String(value));
' "${CCQ_STEPS_CONTRACT}" "${step_id}" "${field}"
    return $?
  fi
  ccq_get_bootstrap_step_field "${step_id}" "${field}"
}

ccq_get_group_step_ids() {
  local group_name="${1:-}"
  [ -z "${group_name}" ] && return 1
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const group = contract.Groups[process.argv[2]];
if (!group) process.exit(1);
process.stdout.write((group.StepIds || []).join("\n"));
' "${CCQ_STEPS_CONTRACT}" "${group_name}"
    return $?
  fi
  ccq_registry_init_bootstrap_snapshot
  case "${group_name}" in
    Basic) printf '%s\n' "${CCQ_BOOTSTRAP_GROUP_BASIC[@]}" ;;
    *) return 1 ;;
  esac
}

ccq_get_group_field() {
  local group_name="${1:-}"
  local field="${2:-}"
  [ -z "${group_name}" ] || [ -z "${field}" ] && return 1
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const group = contract.Groups[process.argv[2]];
if (!group) process.exit(1);
const field = process.argv[3];
if (!Object.prototype.hasOwnProperty.call(group, field)) process.exit(1);
const value = group[field];
if (value === undefined) process.exit(1);
if (Array.isArray(value)) process.stdout.write(value.join("\n"));
else process.stdout.write(String(value));
' "${CCQ_STEPS_CONTRACT}" "${group_name}" "${field}"
    return $?
  fi
  case "${group_name}" in
    Basic)
      case "${field}" in
        Label) printf '基础环境' ;;
        Description) printf 'ccq 运行所需基础环境' ;;
        InstallMode) printf 'OneClickOnly' ;;
        *) return 1 ;;
      esac
      ;;
    *) return 1 ;;
  esac
}

ccq_get_step_dependencies() {
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const step of contract.Steps) {
  console.log(`${step.StepId}:${(step.Dependencies || []).join(",")}`);
}
' "${CCQ_STEPS_CONTRACT}"
    return $?
  fi
  ccq_registry_init_bootstrap_snapshot
  local step_id deps
  for step_id in "${CCQ_BOOTSTRAP_STEP_IDS[@]}"; do
    deps="${CCQ_BOOTSTRAP_STEP_DEPS[${step_id}]:-}"
    printf '%s:%s\n' "${step_id}" "${deps// /,}"
  done
}

ccq_get_step_files() {
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const steps = [...contract.Steps].sort((a, b) => (a.Order || 0) - (b.Order || 0));
for (const step of steps) {
  if (step.MacOSStepFile) console.log(step.MacOSStepFile);
}
' "${CCQ_STEPS_CONTRACT}"
    return $?
  fi
  ccq_registry_init_bootstrap_snapshot
  local step_id
  for step_id in "${CCQ_BOOTSTRAP_STEP_IDS[@]}"; do
    printf '%s\n' "${CCQ_BOOTSTRAP_STEP_FILE[${step_id}]}"
  done
}

ccq_registry_contains_id() {
  local needle="${1:-}"
  shift || true
  local item
  for item in "$@"; do
    [ "${item}" = "${needle}" ] && return 0
  done
  return 1
}

ccq_get_execution_order_fallback() {
  ccq_registry_init_bootstrap_snapshot
  local remaining=("$@")
  local ordered=()
  local next_remaining=()
  local step_id dep deps blocked progressed

  while [ "${#remaining[@]}" -gt 0 ]; do
    progressed=0
    next_remaining=()
    for step_id in "${remaining[@]}"; do
      blocked=0
      deps=( ${CCQ_BOOTSTRAP_STEP_DEPS[${step_id}]:-} )
      for dep in "${deps[@]}"; do
        if ccq_registry_contains_id "${dep}" "${remaining[@]}"; then
          blocked=1
          break
        fi
      done
      if [ "${blocked}" = "0" ] && [ "${progressed}" = "0" ]; then
        ordered+=("${step_id}")
        progressed=1
      else
        next_remaining+=("${step_id}")
      fi
    done
    if [ "${progressed}" = "0" ]; then
      ordered+=("${remaining[@]}")
      break
    fi
    remaining=("${next_remaining[@]}")
  done

  printf '%s\n' "${ordered[@]}"
}

ccq_get_execution_order() {
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const requested = process.argv.slice(2);
const stepById = new Map(contract.Steps.map(s => [s.StepId, s]));
let remaining = requested.filter(id => stepById.has(id));
const ordered = [];
while (remaining.length) {
  const canExecute = remaining.filter(id => {
    const deps = stepById.get(id).Dependencies || [];
    return deps.every(dep => !remaining.includes(dep));
  });
  if (!canExecute.length) {
    ordered.push(...remaining);
    break;
  }
  canExecute.sort((a, b) => (stepById.get(a).Order || 999999) - (stepById.get(b).Order || 999999));
  const next = canExecute[0];
  ordered.push(next);
  remaining = remaining.filter(id => id !== next);
}
process.stdout.write(ordered.join("\n"));
' "${CCQ_STEPS_CONTRACT}" "$@"
    return $?
  fi
  ccq_get_execution_order_fallback "$@"
}

# ============ Legacy StepId 映射 ============

ccq_get_legacy_step_id_map() {
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const map = {};
for (const step of contract.Steps) {
  if (step.LegacyIds && Array.isArray(step.LegacyIds)) {
    for (const legacyId of step.LegacyIds) {
      map[legacyId] = step.StepId;
    }
  }
}
console.log(JSON.stringify(map, null, 2));
' "${CCQ_STEPS_CONTRACT}"
    return $?
  fi
  # Bootstrap snapshot 无 legacy 映射
  printf '{}\n'
}

ccq_resolve_legacy_step_id() {
  local step_id="${1:-}"
  [ -z "${step_id}" ] && return 1

  if ccq_registry_can_use_contract; then
    local map_json resolved
    map_json="$(ccq_get_legacy_step_id_map)"
    resolved="$(printf '%s' "${map_json}" | node -e "
      const map = JSON.parse(require('fs').readFileSync(0, 'utf8'));
      const input = process.argv[1];
      console.log(map[input] || input);
    " "${step_id}" 2>/dev/null || printf '%s' "${step_id}")"
    printf '%s\n' "${resolved}"
    return 0
  fi

  # Bootstrap snapshot 无 legacy 映射，直接返回原 ID
  printf '%s\n' "${step_id}"
}

# ============ 平台过滤 ============

ccq_step_is_supported() {
  local step_id="${1:-}"
  [ -z "${step_id}" ] && return 1

  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const step = contract.Steps.find(s => s.StepId === process.argv[2]);
if (!step) process.exit(1);

// 检查 SupportedPlatforms
const platforms = step.SupportedPlatforms || ["Windows", "macOS"];
if (!platforms.includes("macOS")) process.exit(1);

// 检查 MacOSStepFile 是否存在
if (!step.MacOSStepFile) process.exit(1);

process.exit(0);
' "${CCQ_STEPS_CONTRACT}" "${step_id}"
    return $?
  fi

  # Bootstrap snapshot 中所有步骤都支持 macOS
  ccq_registry_init_bootstrap_snapshot
  [ -n "${CCQ_BOOTSTRAP_STEP_NAME[${step_id}]:-}" ]
}

# ============ 循环依赖检测 ============

ccq_detect_circular_dependencies() {
  if ccq_registry_can_use_contract; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const stepById = new Map(contract.Steps.map(s => [s.StepId, s]));

function hasCycle(stepId, visited = new Set(), stack = new Set()) {
  if (stack.has(stepId)) return true;
  if (visited.has(stepId)) return false;

  visited.add(stepId);
  stack.add(stepId);

  const step = stepById.get(stepId);
  if (step && step.Dependencies) {
    for (const dep of step.Dependencies) {
      if (hasCycle(dep, visited, stack)) return true;
    }
  }

  stack.delete(stepId);
  return false;
}

for (const step of contract.Steps) {
  if (hasCycle(step.StepId)) {
    console.error(`循环依赖检测到: ${step.StepId}`);
    process.exit(1);
  }
}
process.exit(0);
' "${CCQ_STEPS_CONTRACT}"
    return $?
  fi

  # Bootstrap snapshot 已知无循环依赖
  return 0
}


# ─── 来自: macos/core/Bootstrap.zsh ────────────────────────────────────────

# Bootstrap.zsh - macOS 步骤生命周期调度
# 功能: 实时检测生命周期、依赖检查、拓扑排序和 Success/Failed/Skipped/Unsupported/ManualRequired 状态

if [ -n "${CCQ_BOOTSTRAP_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_BOOTSTRAP_ZSH_LOADED=1

CCQ_STEP_STATUS_PENDING="Pending"
CCQ_STEP_STATUS_RUNNING="Running"
CCQ_STEP_STATUS_SUCCESS="Success"
CCQ_STEP_STATUS_FAILED="Failed"
CCQ_STEP_STATUS_SKIPPED="Skipped"
CCQ_STEP_STATUS_UNSUPPORTED="Unsupported"
CCQ_STEP_STATUS_MANUAL_REQUIRED="ManualRequired"

CCQ_STATE_STEP_IDS=()
CCQ_STATE_STEP_STATUSES=()
CCQ_STATE_STEP_MESSAGES=()
CCQ_STATE_STEP_DATA=()

ccq_state_index_of() {
  local step_id="${1:-}"
  local i=1
  while [ "${i}" -le "${#CCQ_STATE_STEP_IDS[@]}" ]; do
    if [ "${CCQ_STATE_STEP_IDS[$i]}" = "${step_id}" ]; then
      printf '%s\n' "${i}"
      return 0
    fi
    i=$((i + 1))
  done
  return 1
}

ccq_state_set_step() {
  local step_id="${1:-}"
  local step_status="${2:-Pending}"
  local message="${3:-}"
  local data="${4:-}"
  local idx
  idx="$(ccq_state_index_of "${step_id}" 2>/dev/null || true)"
  if [ -z "${idx}" ]; then
    CCQ_STATE_STEP_IDS+=("${step_id}")
    CCQ_STATE_STEP_STATUSES+=("${step_status}")
    CCQ_STATE_STEP_MESSAGES+=("${message}")
    CCQ_STATE_STEP_DATA+=("${data}")
  else
    CCQ_STATE_STEP_STATUSES[$idx]="${step_status}"
    CCQ_STATE_STEP_MESSAGES[$idx]="${message}"
    CCQ_STATE_STEP_DATA[$idx]="${data}"
  fi
}

ccq_state_get_status() {
  local idx
  idx="$(ccq_state_index_of "${1:-}" 2>/dev/null || true)"
  [ -n "${idx}" ] || return 1
  printf '%s\n' "${CCQ_STATE_STEP_STATUSES[$idx]}"
}

ccq_state_get_message() {
  local idx
  idx="$(ccq_state_index_of "${1:-}" 2>/dev/null || true)"
  [ -n "${idx}" ] || return 1
  printf '%s\n' "${CCQ_STATE_STEP_MESSAGES[$idx]}"
}

ccq_state_get_data() {
  local idx
  idx="$(ccq_state_index_of "${1:-}" 2>/dev/null || true)"
  [ -n "${idx}" ] || return 1
  printf '%s\n' "${CCQ_STATE_STEP_DATA[$idx]}"
}

ccq_normalize_success() {
  local value="${1:-}"
  case "${value}" in
    true|True|TRUE|1|yes|Yes|success|Success) return 0 ;;
    *) return 1 ;;
  esac
}

ccq_call_step_function() {
  local function_name="${1:-}"
  [ -n "${function_name}" ] || return 1
  if ! command -v "${function_name}" >/dev/null 2>&1; then
    CCQ_LAST_STEP_MESSAGE="函数不存在: ${function_name}"
    return 127
  fi
  "${function_name}"
}

ccq_capture_step_function() {
  local function_name="${1:-}"
  local stderr_mode="${2:-capture}"
  local output_file error_file cmd_status
  [ -n "${function_name}" ] || return 1
  if ! command -v "${function_name}" >/dev/null 2>&1; then
    CCQ_CAPTURED_STEP_OUTPUT=""
    CCQ_LAST_STEP_MESSAGE="函数不存在: ${function_name}"
    return 127
  fi

  output_file="$(mktemp "${TMPDIR:-/tmp}/ccq-step.XXXXXX")" || return 1
  case "${stderr_mode}" in
    discard)
      "${function_name}" >"${output_file}" 2>/dev/null
      cmd_status=$?
      ;;
    developer)
      error_file="$(mktemp "${TMPDIR:-/tmp}/ccq-step-err.XXXXXX")" || { rm -f "${output_file}"; return 1; }
      "${function_name}" >"${output_file}" 2>"${error_file}"
      cmd_status=$?
      if command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer && command -v ccq_tty_available >/dev/null 2>&1 && ccq_tty_available; then
        [ -s "${error_file}" ] && cat "${error_file}" > /dev/tty 2>/dev/null || true
      fi
      cat "${error_file}" >>"${output_file}" 2>/dev/null || true
      rm -f "${error_file}"
      ;;
    *)
      "${function_name}" >"${output_file}" 2>&1
      cmd_status=$?
      ;;
  esac
  CCQ_CAPTURED_STEP_OUTPUT="$(cat "${output_file}" 2>/dev/null || true)"
  rm -f "${output_file}"
  return "${cmd_status}"
}

ccq_parse_result_field() {
  local result="${1:-}"
  local field="${2:-}"
  printf '%s\n' "${result}" | awk -F= -v key="${field}" '$1 == key { sub(/^[^=]*=/, ""); print; found=1 } END { if (!found) exit 1 }'
}

ccq_result_is_installed() {
  local result="${1:-}"
  local value
  value="$(ccq_parse_result_field "${result}" "IsInstalled" 2>/dev/null || true)"
  ccq_normalize_success "${value}"
}

ccq_result_is_success() {
  local result="${1:-}"
  local value
  value="$(ccq_parse_result_field "${result}" "Success" 2>/dev/null || true)"
  ccq_normalize_success "${value}"
}

ccq_test_step_dependencies() {
  local step_id="${1:-}"
  local deps dep dep_status dep_test dep_result
  deps="$(ccq_get_step_field "${step_id}" Dependencies 2>/dev/null || true)"
  [ -z "${deps}" ] && return 0

  for dep in ${deps}; do
    dep_status="$(ccq_state_get_status "${dep}" 2>/dev/null || true)"
    case "${dep_status}" in
      "${CCQ_STEP_STATUS_SUCCESS}"|"${CCQ_STEP_STATUS_SKIPPED}") continue ;;
      "${CCQ_STEP_STATUS_FAILED}"|"${CCQ_STEP_STATUS_UNSUPPORTED}"|"${CCQ_STEP_STATUS_MANUAL_REQUIRED}")
        CCQ_LAST_STEP_MESSAGE="依赖 ${dep} 状态为 ${dep_status}"
        return 1
        ;;
    esac

    dep_test="$(ccq_get_step_field "${dep}" TestFunction 2>/dev/null || true)"
    if [ -n "${dep_test}" ] && command -v "${dep_test}" >/dev/null 2>&1; then
      ccq_capture_step_function "${dep_test}" discard || true
      dep_result="${CCQ_CAPTURED_STEP_OUTPUT}"
      if ccq_result_is_installed "${dep_result}"; then
        continue
      fi
    fi
    CCQ_LAST_STEP_MESSAGE="依赖未满足: ${dep}"
    return 1
  done
  return 0
}

ccq_invoke_step_lifecycle() {
  local step_id="${1:-}"
  [ -z "${step_id}" ] && return 1

  local step_name test_function install_function verify_function skip_if_installed
  step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
  test_function="$(ccq_get_step_field "${step_id}" TestFunction 2>/dev/null || true)"
  install_function="$(ccq_get_step_field "${step_id}" InstallFunction 2>/dev/null || true)"
  verify_function="$(ccq_get_step_field "${step_id}" VerifyFunction 2>/dev/null || true)"
  skip_if_installed="$(ccq_get_step_field "${step_id}" SkipIfInstalled 2>/dev/null || printf 'false')"

  ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_RUNNING}" ""

  if ! ccq_test_step_dependencies "${step_id}"; then
    ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_SKIPPED}" "${CCQ_LAST_STEP_MESSAGE:-依赖未满足}"
    command -v ccq_show_step_progress >/dev/null 2>&1 && ccq_show_step_progress "${step_name}" "Skipped" "${CCQ_LAST_STEP_MESSAGE:-依赖未满足}"
    return 0
  fi

  local test_result=""
  if [ -n "${test_function}" ] && command -v "${test_function}" >/dev/null 2>&1; then
    command -v ccq_ui_runtime_info >/dev/null 2>&1 && ccq_ui_runtime_info "  🔍 测试阶段: ${test_function}"
    ccq_capture_step_function "${test_function}" discard || true
    test_result="${CCQ_CAPTURED_STEP_OUTPUT}"
    if ccq_result_is_installed "${test_result}" && ccq_normalize_success "${skip_if_installed}"; then
      ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_SKIPPED}" "组件已安装，跳过安装" "${test_result}"
      command -v ccq_show_step_progress >/dev/null 2>&1 && ccq_show_step_progress "${step_name}" "Skipped" "组件已安装，跳过安装"
      return 0
    fi
  fi

  if [ -z "${install_function}" ] || ! command -v "${install_function}" >/dev/null 2>&1; then
    ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_MANUAL_REQUIRED}" "安装函数不存在: ${install_function}"
    command -v ccq_show_step_progress >/dev/null 2>&1 && ccq_show_step_progress "${step_name}" "ManualRequired" "安装函数不存在"
    return 0
  fi

  local install_result install_status
  command -v ccq_ui_runtime_info >/dev/null 2>&1 && ccq_ui_runtime_info "  🔧 安装阶段: ${install_function}"
  ccq_capture_step_function "${install_function}" developer
  install_status=$?
  install_result="${CCQ_CAPTURED_STEP_OUTPUT}"
  if [ "${install_status}" -ne 0 ] || ! ccq_result_is_success "${install_result}"; then
    local result_status
    result_status="$(ccq_parse_result_field "${install_result}" "Status" 2>/dev/null || true)"
    case "${result_status}" in
      Unsupported) ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_UNSUPPORTED}" "${install_result}" ;;
      ManualRequired) ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_MANUAL_REQUIRED}" "${install_result}" ;;
      *) ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_FAILED}" "${install_result}" ;;
    esac
    command -v ccq_show_step_progress >/dev/null 2>&1 && ccq_show_step_progress "${step_name}" "$(ccq_state_get_status "${step_id}")" "${install_result}"
    return 1
  fi

  if [ -n "${verify_function}" ] && command -v "${verify_function}" >/dev/null 2>&1; then
    local verify_result verify_status
    command -v ccq_ui_runtime_info >/dev/null 2>&1 && ccq_ui_runtime_info "  ✅ 验证阶段: ${verify_function}"
    ccq_capture_step_function "${verify_function}" developer
    verify_status=$?
    verify_result="${CCQ_CAPTURED_STEP_OUTPUT}"
    if [ "${verify_status}" -ne 0 ] || ! ccq_result_is_success "${verify_result}"; then
      ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_FAILED}" "${verify_result}"
      command -v ccq_show_step_progress >/dev/null 2>&1 && ccq_show_step_progress "${step_name}" "Failed" "${verify_result}"
      return 1
    fi
  fi

  ccq_state_set_step "${step_id}" "${CCQ_STEP_STATUS_SUCCESS}" "步骤安装成功" "${install_result}"
  command -v ccq_show_step_progress >/dev/null 2>&1 && ccq_show_step_progress "${step_name}" "Success" "步骤安装成功"
}

ccq_run_steps() {
  local ordered
  ordered="$(ccq_get_execution_order "$@")" || return 1
  local step_id
  for step_id in ${ordered}; do
    ccq_invoke_step_lifecycle "${step_id}"
    local lifecycle_status=$?

    # Critical 失败策略：检查是否为 critical 步骤
    if [ "${lifecycle_status}" -ne 0 ]; then
      local is_optional
      is_optional="$(ccq_get_step_field "${step_id}" IsOptional 2>/dev/null || printf 'false')"

      # 非可选步骤失败时中止后续步骤
      if ! ccq_normalize_success "${is_optional}"; then
        local step_status
        step_status="$(ccq_state_get_status "${step_id}" 2>/dev/null || echo 'Failed')"

        # Unsupported 和 ManualRequired 不中止流程
        case "${step_status}" in
          "${CCQ_STEP_STATUS_UNSUPPORTED}"|"${CCQ_STEP_STATUS_MANUAL_REQUIRED}") ;;
          *)
            if command -v ccq_ui_danger >/dev/null 2>&1; then
              ccq_ui_danger "关键步骤 ${step_id} 失败，中止后续安装"
            fi
            return 1
            ;;
        esac
      fi
    fi
  done
  return 0
}

# ============ 最终摘要增强 ============

ccq_show_installation_summary() {
  local pass_count=0 fail_count=0 skip_count=0 unsupported_count=0 manual_count=0
  local i=1

  while [ "${i}" -le "${#CCQ_STATE_STEP_IDS[@]}" ]; do
    local summary_status="${CCQ_STATE_STEP_STATUSES[$i]:-}"
    case "${summary_status}" in
      "${CCQ_STEP_STATUS_SUCCESS}") pass_count=$((pass_count + 1)) ;;
      "${CCQ_STEP_STATUS_FAILED}") fail_count=$((fail_count + 1)) ;;
      "${CCQ_STEP_STATUS_SKIPPED}") skip_count=$((skip_count + 1)) ;;
      "${CCQ_STEP_STATUS_UNSUPPORTED}") unsupported_count=$((unsupported_count + 1)) ;;
      "${CCQ_STEP_STATUS_MANUAL_REQUIRED}") manual_count=$((manual_count + 1)) ;;
    esac
    i=$((i + 1))
  done

  if command -v ccq_ui_primary >/dev/null 2>&1; then
    ccq_ui_primary ""
    ccq_ui_primary "============ 安装摘要 ============"
  fi

  if command -v ccq_ui_success >/dev/null 2>&1 && [ "${pass_count}" -gt 0 ]; then
    ccq_ui_success "  [PASS]         ${pass_count} 个步骤"
  fi
  if command -v ccq_ui_danger >/dev/null 2>&1 && [ "${fail_count}" -gt 0 ]; then
    ccq_ui_danger "  [FAIL]         ${fail_count} 个步骤"
  fi
  if command -v ccq_ui_info >/dev/null 2>&1 && [ "${skip_count}" -gt 0 ]; then
    ccq_ui_info "  [SKIP]         ${skip_count} 个步骤"
  fi
  if command -v ccq_ui_dim >/dev/null 2>&1 && [ "${unsupported_count}" -gt 0 ]; then
    ccq_ui_dim "  [UNSUPPORTED]  ${unsupported_count} 个步骤"
  fi
  if command -v ccq_ui_warning >/dev/null 2>&1 && [ "${manual_count}" -gt 0 ]; then
    ccq_ui_warning "  [MANUAL]       ${manual_count} 个步骤"
  fi

  if command -v ccq_ui_primary >/dev/null 2>&1; then
    ccq_ui_primary "=================================="
  fi

  # 返回码：失败数 > 0 返回 1
  [ "${fail_count}" -eq 0 ]
}

# ============ 错误详情展开 ============

ccq_show_error_details() {
  local step_id="${1:-}"
  local error_message="${2:-}"
  local exit_code="${3:-1}"

  if command -v ccq_ui_danger >/dev/null 2>&1; then
    ccq_ui_danger ""
    ccq_ui_danger "步骤失败: ${step_id}"
    ccq_ui_danger "错误摘要: ${error_message}"
  fi

  # 检查是否为 Developer 模式
  local is_developer=0
  if command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer; then
    is_developer=1
  fi

  # Developer 模式自动展开详情
  if [ "${is_developer}" = "1" ]; then
    if command -v ccq_ui_dim >/dev/null 2>&1; then
      ccq_ui_dim ""
      ccq_ui_dim "技术详情:"
      ccq_ui_dim "  退出码: ${exit_code}"
      ccq_ui_dim "  步骤 ID: ${step_id}"
      [ -n "${CCQ_LAST_ERROR:-}" ] && ccq_ui_dim "  错误输出: ${CCQ_LAST_ERROR}"
      [ -n "${CCQ_LAST_OUTPUT:-}" ] && ccq_ui_dim "  标准输出: ${CCQ_LAST_OUTPUT}"
    fi
  else
    # 非 Developer 模式提示按 D 展开
    if command -v ccq_ui_info >/dev/null 2>&1; then
      ccq_ui_info ""
      ccq_ui_info "按 D 键查看技术详情，或按其他键继续..."
    fi

    # 读取单个按键
    local key
    if command -v ccq_tty_available >/dev/null 2>&1 && ccq_tty_available; then
      read -sk 1 key 2>/dev/null || key=""
      if [ "${key}" = "d" ] || [ "${key}" = "D" ]; then
        if command -v ccq_ui_dim >/dev/null 2>&1; then
          ccq_ui_dim ""
          ccq_ui_dim "技术详情:"
          ccq_ui_dim "  退出码: ${exit_code}"
          ccq_ui_dim "  步骤 ID: ${step_id}"
          [ -n "${CCQ_LAST_ERROR:-}" ] && ccq_ui_dim "  错误输出: ${CCQ_LAST_ERROR}"
          [ -n "${CCQ_LAST_OUTPUT:-}" ] && ccq_ui_dim "  标准输出: ${CCQ_LAST_OUTPUT}"
        fi
      fi
    fi
  fi
}


# ─── 来自: macos/core/Update.zsh ────────────────────────────────────────

# Update.zsh - macOS Update 生命周期支持函数
# 功能: 更新锁、npm 缓存、快照——供 Manage.zsh 调用
# 依赖: Profile.zsh (备份/原子写入), Process.zsh

if [ -n "${CCQ_UPDATE_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_UPDATE_ZSH_LOADED=1

: "${CCQ_UPDATE_LOCK:=${TMPDIR:-/tmp}/.ccq-update.lock}"
: "${CCQ_UPDATE_LOCK_TIMEOUT:=30}"
: "${CCQ_UPDATE_MANIFEST:=${HOME}/.ccq/update-manifest.json}"

# ─── 更新清单（内容指纹管理）──────────────────────────────────────────────

ccq_update_manifest_path() { printf '%s\n' "${CCQ_UPDATE_MANIFEST}"; }

# 读取清单（容错：文件不存在或损坏时返回空清单）
ccq_update_read_manifest() {
  local manifest_path
  manifest_path="$(ccq_update_manifest_path)"
  if [ ! -f "${manifest_path}" ] || ! command -v node >/dev/null 2>&1; then
    printf '{"schemaVersion":1,"steps":{}}\n'
    return 0
  fi
  node -e '
const fs = require("fs");
try {
  const raw = fs.readFileSync(process.argv[1], "utf8").trim();
  const obj = raw ? JSON.parse(raw) : {};
  if (!obj.steps || typeof obj.steps !== "object" || Array.isArray(obj.steps)) obj.steps = {};
  obj.schemaVersion = obj.schemaVersion || 1;
  process.stdout.write(JSON.stringify(obj));
} catch (e) {
  process.stdout.write(JSON.stringify({ schemaVersion: 1, steps: {} }));
}
' "${manifest_path}" 2>/dev/null || printf '{"schemaVersion":1,"steps":{}}\n'
}

# 写入某个步骤的清单条目: ccq_update_write_manifest_entry <stepId> <entryJson>
ccq_update_write_manifest_entry() {
  local step_id="${1:-}"
  local entry_json="${2:-}"
  local manifest_path merged
  [ -n "${step_id}" ] && [ -n "${entry_json}" ] || return 1
  command -v node >/dev/null 2>&1 || return 1
  manifest_path="$(ccq_update_manifest_path)"

  merged="$(ccq_update_read_manifest | STEP_ID="${step_id}" ENTRY_JSON="${entry_json}" node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
manifest.steps[process.env.STEP_ID] = JSON.parse(process.env.ENTRY_JSON);
manifest.updatedAt = new Date().toISOString();
process.stdout.write(JSON.stringify(manifest, null, 2));
')" || return 1
  ccq_json_write_atomic "${manifest_path}" "${merged}"
}

# 读取某个步骤的清单条目 JSON（不存在输出 {}）
ccq_update_get_manifest_entry() {
  local step_id="${1:-}"
  [ -n "${step_id}" ] || { printf '{}'; return 0; }
  ccq_update_read_manifest | STEP_ID="${step_id}" node -e '
const fs = require("fs");
const manifest = JSON.parse(fs.readFileSync(0, "utf8"));
process.stdout.write(JSON.stringify(manifest.steps[process.env.STEP_ID] || {}));
' 2>/dev/null || printf '{}'
}

# ─── SHA256 指纹（内容变更检测）───────────────────────────────────────────

ccq_string_fingerprint() {
  printf '%s' "${1:-}" | shasum -a 256 2>/dev/null | awk '{print $1}'
}

ccq_file_fingerprint() {
  local file_path="${1:-}"
  [ -f "${file_path}" ] || return 1
  shasum -a 256 "${file_path}" 2>/dev/null | awk '{print $1}'
}

# ─── 更新锁（防并发损坏）───────────────────────────────────────────────────

ccq_update_acquire_lock() {
  local lock_file="${CCQ_UPDATE_LOCK}"
  local timeout="${CCQ_UPDATE_LOCK_TIMEOUT}"
  local elapsed=0

  ccq_ensure_dir "$(dirname "${lock_file}")"

  while [ "${elapsed}" -lt "${timeout}" ]; do
    if (set -C; : > "${lock_file}") 2>/dev/null; then
      echo $$ > "${lock_file}"
      return 0
    fi

    if [ -f "${lock_file}" ]; then
      local lock_pid
      lock_pid="$(cat "${lock_file}" 2>/dev/null || echo "")"
      if [ -n "${lock_pid}" ] && ! kill -0 "${lock_pid}" 2>/dev/null; then
        rm -f "${lock_file}"
        continue
      fi
    fi

    sleep 1
    elapsed=$((elapsed + 1))
  done

  return 1
}

ccq_update_release_lock() {
  local lock_file="${CCQ_UPDATE_LOCK}"
  [ -f "${lock_file}" ] && rm -f "${lock_file}"
}

# ─── npm outdated 全局缓存（1 次查询全部包）────────────────────────────────

_ccq_npm_outdated_cache=""

ccq_npm_outdated_global() {
  local force="${1:-false}"
  case "${force}" in
    --refresh|true) force="true" ;;
    *) force="false" ;;
  esac

  if [ "${force}" != "true" ] && [ -n "${_ccq_npm_outdated_cache}" ]; then
    printf '%s\n' "${_ccq_npm_outdated_cache}"
    return 0
  fi

  if ! command -v npm >/dev/null 2>&1; then
    printf '{}\n'
    return 0
  fi

  local outdated_json
  # npm outdated 有可更新包时会返回 exit 1，但 stdout 仍是有效 JSON；不能用 || 追加 {}
  # 否则会形成两个 JSON 文档，导致下游 JSON.parse 报错。
  outdated_json="$(npm outdated -g --json 2>/dev/null)"

  if [ -z "${outdated_json}" ] || [ "${outdated_json}" = "null" ]; then
    outdated_json="{}"
  elif ! printf '%s' "${outdated_json}" | node -e 'JSON.parse(require("fs").readFileSync(0, "utf8"));' >/dev/null 2>&1; then
    outdated_json="{}"
  fi

  _ccq_npm_outdated_cache="${outdated_json}"
  printf '%s\n' "${outdated_json}"
}

ccq_npm_package_has_update() {
  local package_name="${1:-}"
  local cache
  cache="$(ccq_npm_outdated_global false)"

  printf '%s' "${cache}" | PKG="${package_name}" node -e '
const outdated = JSON.parse(require("fs").readFileSync(0, "utf8"));
const pkg = process.env.PKG;
console.log(outdated[pkg] ? "true" : "false");
' 2>/dev/null || printf 'false\n'
}

# ─── 更新快照（备份关键文件，可回滚）──────────────────────────────────────

ccq_update_snapshot_files() {
  cat <<'EOF'
.claude/settings.json
.claude.json
.claude/CLAUDE.md
.ccq/mcp-meta.json
EOF
  # ccq 动态渲染的 rules 文件（按实际存在枚举）
  local rules_file
  for rules_file in "${HOME}"/.claude/rules/ccq-*.md(N); do
    printf '%s\n' "${rules_file#${HOME}/}"
  done
}

ccq_update_create_snapshot() {
  local timestamp guid8 dir_name snapshot_dir manifest_json file_list file_path relative_path dest_path dest_dir hash
  timestamp="$(date '+%Y%m%d_%H%M%S')"
  guid8="$(uuidgen 2>/dev/null | tr -d '-' | cut -c1-8 || od -An -N4 -tx1 /dev/urandom | tr -d ' ')"
  dir_name="update_${timestamp}_$$_${guid8}"
  snapshot_dir="${CCQ_BACKUP_DIR}/${dir_name}"

  ccq_ensure_dir "${snapshot_dir}"

  local canary_path="${snapshot_dir}/_canary.tmp"
  printf 'canary\n' > "${canary_path}" || return 1
  [ -f "${canary_path}" ] || return 1
  rm -f "${canary_path}"

  manifest_json='{"createdAt":"'$(date -u '+%Y-%m-%dT%H:%M:%SZ')'","files":[]}'

  file_list="$(ccq_update_snapshot_files)"
  for file_path in ${(f)file_list}; do
    [ -z "${file_path}" ] && continue
    file_path="${HOME}/${file_path}"
    [ -f "${file_path}" ] || continue

    relative_path="${file_path#${HOME}/}"
    dest_path="${snapshot_dir}/${relative_path}"
    dest_dir="$(dirname "${dest_path}")"
    ccq_ensure_dir "${dest_dir}"

    cp "${file_path}" "${dest_path}" || continue

    hash="$(shasum -a 256 "${file_path}" | awk '{print $1}')"
    manifest_json="$(printf '%s' "${manifest_json}" | \
      FILE_PATH="${file_path}" RELATIVE="${relative_path}" HASH="${hash}" node -e '
const m = JSON.parse(require("fs").readFileSync(0, "utf8"));
m.files.push({
  source: process.env.FILE_PATH,
  relative: process.env.RELATIVE,
  hash: process.env.HASH
});
console.log(JSON.stringify(m, null, 2));
')" || continue
  done

  printf '%s\n' "${manifest_json}" > "${snapshot_dir}/manifest.json"

  # stdout 仅输出快照路径（供调用方捕获）；提示信息走 stderr
  local file_count
  file_count="$(printf '%s' "${manifest_json}" | node -e 'console.log(JSON.parse(require("fs").readFileSync(0,"utf8")).files.length)')"
  ccq_ui_success "✓ 更新快照已创建: ${snapshot_dir} (${file_count} 个文件)" >&2
  printf '%s\n' "${snapshot_dir}"
}

ccq_update_clear_old_snapshots() {
  local max_snapshots="${1:-5}"
  local days_to_keep="${2:-30}"
  local current_snapshot="${3:-}"

  [ -d "${CCQ_BACKUP_DIR}" ] || return 0

  local all_snapshots count_to_remove cutoff_date snapshot
  all_snapshots="$(find "${CCQ_BACKUP_DIR}" -maxdepth 1 -type d -name "update_*" -print0 2>/dev/null | \
    xargs -0 ls -td 2>/dev/null || echo "")"

  local idx=0
  for snapshot in ${(f)all_snapshots}; do
    [ -z "${snapshot}" ] && continue
    [ "${snapshot}" = "${current_snapshot}" ] && continue

    if [ "${idx}" -ge "${max_snapshots}" ]; then
      rm -rf "${snapshot}" 2>/dev/null || true
      continue
    fi

    if [ -n "${days_to_keep}" ] && [ "${days_to_keep}" -gt 0 ]; then
      local snapshot_age
      snapshot_age="$(find "${snapshot}" -maxdepth 0 -mtime +${days_to_keep} 2>/dev/null || echo "")"
      if [ -n "${snapshot_age}" ]; then
        rm -rf "${snapshot}" 2>/dev/null || true
        continue
      fi
    fi

    idx=$((idx + 1))
  done
}


# ─── 来自: macos/steps/NodeJS.zsh ────────────────────────────────────────

# NodeJS.zsh - macOS Node.js / fnm / nvm 安装步骤
# 功能: 优先复用现有 node/npm；不达标时优先使用当前 fnm/nvm 安装/切换 LTS，最后用 nvm 官方脚本兜底

if [ -n "${CCQ_STEP_NODEJS_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_STEP_NODEJS_ZSH_LOADED=1

: "${CCQ_REQUIRED_NODE_MAJOR:=20}"
: "${CCQ_NVM_INSTALL_URL:=https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh}"

ccq_nodejs_result() {
  printf 'IsInstalled=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'Message=%s\n' "${3:-}"
}

ccq_nodejs_install_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'NpmVersion=%s\n' "${3:-}"
  printf 'ErrorMessage=%s\n' "${4:-}"
}

ccq_nodejs_major() {
  local version="${1:-}"
  version="${version#v}"
  printf '%s' "${version%%.*}"
}

ccq_nodejs_versions_ok() {
  if ! ccq_command_exists node || ! ccq_command_exists npm; then
    return 1
  fi
  local node_version node_major
  node_version="$(node --version 2>/dev/null || true)"
  node_major="$(ccq_nodejs_major "${node_version}")"
  [ -n "${node_major}" ] && [ "${node_major}" -ge "${CCQ_REQUIRED_NODE_MAJOR}" ]
}

ccq_nodejs_command_path() {
  local command_name="${1:-}"
  [ -z "${command_name}" ] && return 1
  command -v "${command_name}" 2>/dev/null || true
}

ccq_nodejs_command_source() {
  local command_path="${1:-}"
  [ -z "${command_path}" ] && {
    printf '%s' 'unknown'
    return 0
  }

  case "${command_path}" in
    */.fnm/*|*/fnm/node-versions/*|*/fnm_multishells/*)
      printf '%s' 'fnm'
      return 0
      ;;
    */.nvm/*|*/nvm/versions/node/*)
      printf '%s' 'nvm'
      return 0
      ;;
    /opt/homebrew/*|/usr/local/*)
      printf '%s' 'homebrew'
      return 0
      ;;
    *)
      printf '%s' 'portable'
      return 0
      ;;
  esac
}

ccq_nodejs_active_provider() {
  local node_path npm_path node_source npm_source
  node_path="$(ccq_nodejs_command_path node)"
  npm_path="$(ccq_nodejs_command_path npm)"
  if [ -z "${node_path}" ] && [ -z "${npm_path}" ]; then
    if ccq_nodejs_load_nvm >/dev/null 2>&1; then
      printf '%s' 'nvm'
      return 0
    fi
    printf '%s' 'none'
    return 0
  fi

  node_source="$(ccq_nodejs_command_source "${node_path}")"
  npm_source="$(ccq_nodejs_command_source "${npm_path}")"
  if [ -n "${node_path}" ] && [ -n "${npm_path}" ] && [ "${node_source}" != "${npm_source}" ] && [ "${npm_source}" != "unknown" ]; then
    printf '%s' 'unknown'
    return 0
  fi
  if [ -n "${node_path}" ]; then
    printf '%s' "${node_source}"
  else
    printf '%s' "${npm_source}"
  fi
}

ccq_nodejs_nvm_dir() {
  if [ -n "${NVM_DIR:-}" ]; then
    printf '%s\n' "${NVM_DIR%/}"
  elif [ -n "${XDG_CONFIG_HOME:-}" ]; then
    printf '%s\n' "${XDG_CONFIG_HOME%/}/nvm"
  else
    printf '%s\n' "${HOME}/.nvm"
  fi
}

ccq_nodejs_load_nvm() {
  local nvm_dir nvm_script
  nvm_dir="$(ccq_nodejs_nvm_dir)"
  nvm_script="${nvm_dir}/nvm.sh"
  export NVM_DIR="${nvm_dir}"
  CCQ_NODEJS_LOAD_ERROR=""

  if [ ! -f "${nvm_script}" ]; then
    CCQ_NODEJS_LOAD_ERROR="nvm.sh 不存在: ${nvm_script}"
    return 1
  fi
  if [ ! -s "${nvm_script}" ]; then
    CCQ_NODEJS_LOAD_ERROR="nvm.sh 为空: ${nvm_script}"
    return 1
  fi
  if [ ! -r "${nvm_script}" ]; then
    CCQ_NODEJS_LOAD_ERROR="nvm.sh 不可读: ${nvm_script}"
    return 1
  fi
  if ! . "${nvm_script}" >/dev/null 2>&1; then
    CCQ_NODEJS_LOAD_ERROR="source ${nvm_script} 失败"
    return 1
  fi
  if ! command -v nvm >/dev/null 2>&1; then
    CCQ_NODEJS_LOAD_ERROR="已加载 ${nvm_script}，但未定义 nvm 函数"
    return 1
  fi
}

ccq_nodejs_extract_nvm_error() {
  local output_file="${1:-}"
  local line last_line=""
  if [ -z "${output_file}" ] || [ ! -f "${output_file}" ]; then
    printf '%s' 'nvm 官方安装脚本执行失败'
    return 0
  fi

  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    case "${line}" in
      *"Close and reopen"*|*"run the following"*|*"This loads nvm"*|export\ NVM_DIR*)
        continue
        ;;
    esac
    last_line="${line}"
    case "${line}" in
      *"Xcode Command Line Developer Tools"*|*"xcode-select --install"*)
        printf '%s' '缺少 Xcode Command Line Tools，请执行 xcode-select --install 后重试'
        return 0
        ;;
      *"Failed to clone"*|*"Failed to fetch"*|*"Failed to download"*|*"Could not resolve host"*|*"SSL"*|*"Connection"*"failed"*)
        printf '%s' "${line}"
        return 0
        ;;
      *"Permission denied"*|*"has the same name as installation directory"*|*"directory does not exist"*)
        printf '%s' "${line}"
        return 0
        ;;
    esac
  done < "${output_file}"

  [ -n "${last_line}" ] && printf '%s' "${last_line}" || printf '%s' '未获取到 nvm 安装输出'
}

ccq_nodejs_install_nvm_official() {
  if ccq_nodejs_load_nvm; then
    return 0
  fi
  if ! ccq_command_exists curl; then
    CCQ_NODEJS_ERROR="curl 不可用，无法安装 nvm"
    return 1
  fi
  if ! ccq_command_exists bash; then
    CCQ_NODEJS_ERROR="bash 不可用，无法执行 nvm 官方安装脚本"
    return 1
  fi

  local output_file error_hint
  output_file="$(mktemp "${TMPDIR:-/tmp}/ccq-nvm-install.XXXXXX")" || {
    CCQ_NODEJS_ERROR="无法创建 nvm 安装日志临时文件"
    return 1
  }

  if ! bash -c "set -o pipefail; curl -fsSL '${CCQ_NVM_INSTALL_URL}' | bash" >"${output_file}" 2>&1; then
    command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer && ccq_process_tty_block "$(cat "${output_file}" 2>/dev/null || true)"
    error_hint="$(ccq_nodejs_extract_nvm_error "${output_file}")"
    rm -f "${output_file}"
    CCQ_NODEJS_ERROR="nvm 官方安装脚本执行失败：${error_hint}"
    return 1
  fi
  command -v ccq_output_is_developer >/dev/null 2>&1 && ccq_output_is_developer && ccq_process_tty_block "$(cat "${output_file}" 2>/dev/null || true)"

  if ! ccq_nodejs_load_nvm; then
    error_hint="${CCQ_NODEJS_LOAD_ERROR:-$(ccq_nodejs_extract_nvm_error "${output_file}")}"
    rm -f "${output_file}"
    CCQ_NODEJS_ERROR="nvm 已安装但当前会话未能加载：${error_hint}；请重新打开终端或执行 source \"$(ccq_nodejs_nvm_dir)/nvm.sh\""
    return 1
  fi
  rm -f "${output_file}"
}

ccq_nodejs_install_via_nvm() {
  if ! ccq_nodejs_install_nvm_official; then
    return 1
  fi

  if ! ccq_run_native_command nvm install --lts; then
    CCQ_NODEJS_ERROR="Node.js LTS 安装失败"
    return 1
  fi
  if ! ccq_run_native_command nvm alias default 'lts/*'; then
    CCQ_NODEJS_ERROR="nvm default alias 设置失败"
    return 1
  fi
  if ! ccq_run_native_command nvm use default; then
    CCQ_NODEJS_ERROR="nvm use default 失败"
    return 1
  fi
}

ccq_nodejs_install_via_existing_nvm() {
  if ! ccq_nodejs_load_nvm; then
    CCQ_NODEJS_ERROR="检测到 nvm，但当前会话无法加载：${CCQ_NODEJS_LOAD_ERROR:-未知错误}"
    return 1
  fi
  ccq_nodejs_install_via_nvm
}

ccq_nodejs_install_via_fnm() {
  if ! ccq_command_exists fnm; then
    CCQ_NODEJS_ERROR="fnm 命令不可用，无法通过当前 fnm 安装 Node.js LTS"
    return 1
  fi

  if ! ccq_run_native_command fnm install --lts; then
    CCQ_NODEJS_ERROR="fnm install --lts 失败"
    return 1
  fi
  if ! ccq_run_native_command fnm default lts-latest; then
    CCQ_NODEJS_ERROR="fnm default lts-latest 失败"
    return 1
  fi
  if ! ccq_run_native_command fnm use --install-if-missing lts-latest; then
    CCQ_NODEJS_ERROR="fnm use lts-latest 失败"
    return 1
  fi
  ccq_refresh_path
}

ccq_nodejs_install_runtime_lts() {
  local active_provider="${1:-}"
  case "${active_provider}" in
    fnm)
      ccq_nodejs_install_via_fnm
      return $?
      ;;
    nvm)
      ccq_nodejs_install_via_existing_nvm
      return $?
      ;;
    *)
      ccq_nodejs_install_via_nvm
      return $?
      ;;
  esac
}

Test-NodeJSInstalled() {
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_result true "$(node --version 2>/dev/null || true)" "Node.js 与 npm 已就绪"
    return 0
  fi

  # 当前 PATH 不满足时再刷新常见路径 / nvm default 作为兜底；避免一开始就 source nvm
  # 覆盖用户当前已可用的 fnm/Homebrew/直装 Node.js。
  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_result true "$(node --version 2>/dev/null || true)" "Node.js 与 npm 已就绪"
    return 0
  fi

  local active_provider
  active_provider="$(ccq_nodejs_active_provider)"
  case "${active_provider}" in
    fnm)
      ccq_nodejs_result false "$(node --version 2>/dev/null || true)" "Node.js 未安装、npm 不可用或版本低于 v${CCQ_REQUIRED_NODE_MAJOR}，将通过当前 fnm 安装/切换 LTS"
      ;;
    nvm)
      ccq_nodejs_result false "$(node --version 2>/dev/null || true)" "Node.js 未安装、npm 不可用或版本低于 v${CCQ_REQUIRED_NODE_MAJOR}，将通过当前 nvm 安装/切换 LTS"
      ;;
    *)
      ccq_nodejs_result false "$(node --version 2>/dev/null || true)" "Node.js 未安装、npm 不可用或版本低于 v${CCQ_REQUIRED_NODE_MAJOR}，将通过 nvm 官方脚本安装 Node.js"
      ;;
  esac
}

Install-NodeJS() {
  local error_message="" active_provider=""

  if ccq_nodejs_versions_ok; then
    ccq_nodejs_install_result true "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" ""
    return 0
  fi

  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    ccq_nodejs_install_result true "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" ""
    return 0
  fi

  active_provider="$(ccq_nodejs_active_provider)"
  ccq_nodejs_install_runtime_lts "${active_provider}" || {
    error_message="${CCQ_NODEJS_ERROR:-安装 Node.js LTS 失败}"
    ccq_nodejs_install_result false "" "" "${error_message}"
    return 1
  }

  ccq_refresh_path
  if ! ccq_nodejs_versions_ok; then
    error_message="Node.js 安装后验证失败"
    ccq_nodejs_install_result false "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" "${error_message}"
    return 1
  fi

  ccq_nodejs_install_result true "$(node --version 2>/dev/null || true)" "$(npm --version 2>/dev/null || true)" ""
}

Verify-NodeJS() {
  if ccq_nodejs_versions_ok; then
    printf 'Success=true\n'
    printf 'ErrorMessage=\n'
    return 0
  fi

  ccq_refresh_path
  if ccq_nodejs_versions_ok; then
    printf 'Success=true\n'
    printf 'ErrorMessage=\n'
    return 0
  fi

  printf 'Success=false\n'
  printf 'ErrorMessage=Node.js 或 npm 验证失败\n'
  return 1
}


# ─── 来自: macos/steps/Git.zsh ────────────────────────────────────────

# Git.zsh - macOS Git 安装和基础配置
# 功能: 通过 Homebrew 安装 Git 并应用推荐 global config

if [ -n "${CCQ_STEP_GIT_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_STEP_GIT_ZSH_LOADED=1

: "${CCQ_MIN_GIT_VERSION:=2.30.0}"

ccq_git_result() {
  printf 'IsInstalled=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'Message=%s\n' "${3:-}"
}

ccq_git_install_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'ErrorMessage=%s\n' "${3:-}"
}

ccq_git_version() {
  git --version 2>/dev/null | head -n 1 || true
}

ccq_git_normalize_version() {
  local version="${1:-}"
  version="${version#git version }"
  version="${version%% *}"
  printf '%s' "${version}"
}

ccq_git_version_part() {
  local version="${1:-0}"
  local index="${2:-1}"
  local part rest
  rest="${version}"
  while [ "${index}" -gt 1 ]; do
    case "${rest}" in
      *.*) rest="${rest#*.}" ;;
      *) rest="0" ;;
    esac
    index=$((index - 1))
  done
  part="${rest%%.*}"
  part="${part%%[^0-9]*}"
  printf '%s' "${part:-0}"
}

ccq_git_version_ge() {
  local actual="${1:-0.0.0}"
  local required="${2:-0.0.0}"
  local i actual_part required_part
  for i in 1 2 3; do
    actual_part="$(ccq_git_version_part "${actual}" "${i}")"
    required_part="$(ccq_git_version_part "${required}" "${i}")"
    if [ "${actual_part}" -gt "${required_part}" ]; then return 0; fi
    if [ "${actual_part}" -lt "${required_part}" ]; then return 1; fi
  done
  return 0
}

ccq_git_config_value() {
  git config --global --get "$1" 2>/dev/null || true
}

ccq_git_has_required_config() {
  [ "$(ccq_git_config_value init.defaultBranch)" = "main" ] || return 1
  [ "$(ccq_git_config_value core.quotepath)" = "false" ] || return 1
  return 0
}

# 推荐配置键值对（与 Windows recommendedConfigs 对齐）
ccq_git_recommended_configs() {
  cat <<'EOF'
init.defaultBranch	main	默认分支名
core.quotepath	false	中文文件名显示
i18n.commit.encoding	utf-8	提交信息编码
i18n.logoutputencoding	utf-8	日志输出编码
EOF
}

# 写入推荐配置：已有用户值不覆盖（spec: 用户配置保护）
ccq_git_apply_config() {
  local key value desc existing failed=0
  while IFS=$'\t' read -r key value desc; do
    [ -n "${key}" ] || continue
    existing="$(ccq_git_config_value "${key}")"
    if [ -n "${existing}" ] && [ "${existing}" != "${value}" ]; then
      ccq_ui_info "  ${desc} 已存在用户配置: ${existing}（不覆盖）" "developer"
      continue
    fi
    if [ "${existing}" = "${value}" ]; then
      continue
    fi
    if git config --global "${key}" "${value}" 2>/dev/null; then
      ccq_ui_success "  ${desc} 配置成功: ${value}" "developer"
    else
      ccq_ui_warning "  ${desc} 配置失败: ${key}" "developer"
      failed=$((failed + 1))
    fi
  done <<EOF
$(ccq_git_recommended_configs)
EOF
  [ "${failed}" -eq 0 ]
}

ccq_git_version_ok() {
  if ! ccq_command_exists git; then
    return 1
  fi
  local version
  version="$(ccq_git_normalize_version "$(ccq_git_version)")"
  [ -n "${version}" ] && ccq_git_version_ge "${version}" "${CCQ_MIN_GIT_VERSION}"
}

Test-GitInstalled() {
  if ! ccq_git_version_ok; then
    ccq_git_result false "$(ccq_git_version)" "Git 未安装或版本过低"
    return 0
  fi
  if ! ccq_git_has_required_config; then
    ccq_git_result false "$(ccq_git_version)" "Git 推荐配置未完成"
    return 0
  fi
  ccq_git_result true "$(ccq_git_version)" "Git 已安装并完成推荐配置"
}

Install-Git() {
  if ! ccq_git_version_ok; then
    if ! ccq_brew_available; then
      printf 'Success=false\n'
      printf 'Status=ManualRequired\n'
      printf 'ErrorMessage=Homebrew 不可用，请先安装 Homebrew 后重试\n'
      return 1
    fi

    if ! ccq_brew_install_formula git; then
      ccq_git_install_result false "$(ccq_git_version)" "brew install git 失败"
      return 1
    fi

    ccq_refresh_path
    if ! ccq_git_version_ok; then
      ccq_git_install_result false "$(ccq_git_version)" "Git 安装后仍不可用"
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
    printf 'Success=true\n'
    printf 'ErrorMessage=\n'
    return 0
  fi
  printf 'Success=false\n'
  printf 'ErrorMessage=Git 安装或推荐配置验证失败\n'
  return 1
}


# ─── 来自: macos/Install.zsh ────────────────────────────────────────

# Install.zsh - macOS 安装入口
# 功能: 前置检测、分组安装、执行计划确认和 ccq 快捷函数注册

setopt NO_NOMATCH
setopt PIPE_FAIL
setopt SH_WORD_SPLIT

# 避免继承上游 zsh xtrace，防止内部变量赋值污染安装输出。
set +x 2>/dev/null || true
unsetopt XTRACE 2>/dev/null || true
setopt NO_XTRACE 2>/dev/null || true

CCQ_MACOS_ROOT="$(cd "$(dirname "${0:A}")" && pwd)"
CCQ_INSTALLER_ROOT="$(cd "${CCQ_MACOS_ROOT}/.." && pwd)"
export CCQ_MACOS_ROOT CCQ_INSTALLER_ROOT

CCQ_PARAM_LIST_STEPS=0
CCQ_PARAM_OUTPUT_MODE="normal"
: "${CCQ_RELEASE_TAG:=__CCQ_RELEASE_TAG__}"

ccq_usage() {
  cat <<'EOF'
Usage: Install.zsh [OPTIONS]

Options:
  -ListSteps, --list-steps        列出已注册步骤后退出
  -OutputMode, --output-mode <Normal|Developer>
  -h, --help                     显示帮助
EOF
}

ccq_parse_args() {
  while [ "$#" -gt 0 ]; do
    case "$1" in
      -ListSteps|--list-steps)
        CCQ_PARAM_LIST_STEPS=1
        shift
        ;;
      -OutputMode|--output-mode)
        CCQ_PARAM_OUTPUT_MODE="${2:-normal}"
        shift 2
        ;;
      -h|--help)
        ccq_usage
        exit 0
        ;;
      *)
        printf '未知参数: %s\n' "$1" >&2
        ccq_usage >&2
        exit 2
        ;;
    esac
  done

  case "${CCQ_PARAM_OUTPUT_MODE:l}" in
    developer) CCQ_PARAM_OUTPUT_MODE="developer" ;;
    *) CCQ_PARAM_OUTPUT_MODE="normal" ;;
  esac
}

# ─── 加载 core（顺序声明唯一位于 core/Load.zsh）─────────────────────────────
# 本入口不再硬编码 core 文件列表：只 source Load.zsh 并调用 ccq_load_core。
# 专用入口 Download-Tui.zsh 复用同一份声明。
#
# 为什么 macOS 不能用 build.json 做 manifest 驱动加载：读取 JSON 只能依赖 node
# （见 core/Json.zsh / core/Registry.zsh），而 CCQ 专用入口恰恰不能依赖 node，
# 因此加载顺序改由 contracts/Test-Contracts.ps1 断言 build.json 的
# MacOS.Artifacts[*].CoreFiles 与 Load.zsh 的 CCQ_CORE_ORDER 声明集合一致；
# 二者漂移必然导致门禁失败。

ccq_load_step_modules() {
  if [ "${CCQ_BUILT_MODE:-0}" = "1" ]; then
    return 0
  fi

  local step_files step_file full_path
  step_files="$(ccq_get_step_files 2>/dev/null || true)"
  if [ -z "${step_files}" ]; then
    ccq_ui_warning "未能读取 macOS 步骤文件清单；仅可使用入口与管理骨架" "developer"
    return 0
  fi

  for step_file in ${step_files}; do
    full_path="${CCQ_INSTALLER_ROOT}/${step_file}"
    if [ -f "${full_path}" ]; then
    else
      ccq_ui_warning "步骤模块尚未实现，跳过加载: ${step_file}" "developer"
    fi
  done
}

ccq_preflight() {
  if ! ccq_assert_macos_supported 12; then
    ccq_ui_danger "${CCQ_LAST_PLATFORM_ERROR:-macOS 版本检查失败}"
    return 1
  fi

  if ! ccq_is_zsh_shell; then
    ccq_ui_warning "当前登录 Shell 不是 zsh；如需切换请手动执行: chsh -s /bin/zsh"
  fi

  if ! command -v plutil >/dev/null 2>&1; then
    ccq_ui_danger "缺少 macOS plutil，无法进行 JSON 前置校验"
    return 1
  fi

  if ! ccq_brew_available; then
    ccq_ui_warning "Homebrew 未安装，macOS 自动化安装需要 Homebrew"
    ccq_ui_info "将执行 Homebrew 官方安装命令："
    ccq_ui_dim "$(ccq_homebrew_install_command)"

    ccq_ui_primary "正在执行 Homebrew 官方安装脚本..."
    if ! ccq_install_homebrew; then
      ccq_ui_danger "Homebrew 安装失败，请按提示手动处理后重新运行 CCQ"
      ccq_homebrew_install_hint
      return 1
    fi

    if ! ccq_brew_available; then
      ccq_ui_danger "Homebrew 安装后仍不可用，请重新打开终端后重试"
      return 1
    fi

    ccq_apply_homebrew_post_install_steps "$(ccq_zprofile_path)" >/dev/null 2>&1 || \
      ccq_ui_warning "Homebrew 官方后续初始化失败；后续命令可能需要重新打开终端" "developer"
  fi

  ccq_refresh_path
}

# ─── 旧 Profile 标记块迁移清理 ─────────────────────────────────────────────────

ccq_cleanup_legacy_profile_blocks() {
  # 清理 ~/.zshrc 中历史遗留的 CCQ 标记块（旧 ccq 快捷函数注入残留）。
  # 旧 ClaudeConfig 步骤曾把 ccq() {...} 包在 HC-4 标记块里注入 ~/.zshrc（commit 429637c），
  # 迁移到 ccq 单文件可执行 + PATH 后注入逻辑已删，但用户机器残留未清。旧 ccq 函数会
  # curl 旧 install.sh，与新 ccq 可执行文件冲突，故在前置检测后清理。仅清标记块包裹内容，
  # 块外用户自定义不动；清理函数幂等，无块则 no-op。失败仅告警，不阻断主安装流程。
  local zshrc_path

  zshrc_path="$(ccq_zshrc_path)"
  [ -f "${zshrc_path}" ] || return 0

  # 探测是否存在标记块；无块则静默跳过
  if ! ccq_get_managed_block_content "${zshrc_path}" >/dev/null 2>&1; then
    return 0
  fi

  ccq_ui_dim "检测到旧 CCQ 标记块: ${zshrc_path}" "developer"
  if ccq_remove_managed_block_from_file "${zshrc_path}"; then
    ccq_ui_success "✓ 已清理旧 ccq 快捷函数残留: ${zshrc_path}"
  else
    ccq_ui_warning "清理旧 CCQ 标记块失败: ${zshrc_path}"
  fi

  return 0
}

ccq_bool_true() {
  case "${1:-}" in
    true|True|TRUE|1|yes|Yes) return 0 ;;
    *) return 1 ;;
  esac
}

ccq_array_contains() {
  local needle="${1:-}"
  shift || true
  local item
  for item in "$@"; do
    [ "${item}" = "${needle}" ] && return 0
  done
  return 1
}

ccq_collect_dependencies() {
  local step_id="${1:-}"
  shift || true
  local seen=("$@")
  local dep deps

  if ccq_array_contains "${step_id}" "${seen[@]}"; then
    printf '%s\n' "${seen[@]}"
    return 0
  fi

  seen+=("${step_id}")
  deps="$(ccq_get_step_field "${step_id}" Dependencies 2>/dev/null || true)"
  for dep in ${deps}; do
    seen=( $(ccq_collect_dependencies "${dep}" "${seen[@]}") )
  done
  printf '%s\n' "${seen[@]}"
}

ccq_dependency_closure() {
  local selected=("$@")
  local all=()
  local step_id collected item
  for step_id in "${selected[@]}"; do
    collected="$(ccq_collect_dependencies "${step_id}" "${all[@]}")"
    all=( ${collected} )
  done
  ccq_get_execution_order "${all[@]}"
}

ccq_prompt_single() {
  local title="${1:-请选择}"
  local default_index="${2:-0}"
  shift 2 || true
  ccq_show_single_select_menu "${title}" "${default_index}" "$@"
}

ccq_prompt_multi() {
  local title="${1:-请选择}"
  local default_indices="${2:-}"
  shift 2 || true
  ccq_show_multi_select_menu "${title}" "${default_indices}" "$@"
}

ccq_show_step_list() {
  local group_name step_ids step_id step_name description optional deps tag group_label group_desc index=0
  ccq_ui_primary "已注册的安装步骤："
  printf '\n'
  for group_name in Basic; do
    step_ids="$(ccq_get_group_step_ids "${group_name}" 2>/dev/null || true)"
    [ -n "${step_ids}" ] || continue
    group_label="$(ccq_get_group_field "${group_name}" Label 2>/dev/null || printf '%s' "${group_name}")"
    group_desc="$(ccq_get_group_field "${group_name}" Description 2>/dev/null || true)"
    ccq_ui_primary "─── ${group_label}（${group_desc}）───"
    printf '\n'
    for step_id in ${step_ids}; do
      index=$((index + 1))
      step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
      description="$(ccq_get_step_field "${step_id}" Description 2>/dev/null || true)"
      optional="$(ccq_get_step_field "${step_id}" IsOptional 2>/dev/null || printf 'false')"
      deps="$(ccq_get_step_field "${step_id}" Dependencies 2>/dev/null | paste -sd ',' - || true)"
      tag="[必选]"
      ccq_bool_true "${optional}" && tag="[可选]"
      ccq_ui_info "  ${index}. ${tag} ${step_name}"
      ccq_ui_dim "       ${description}"
      ccq_ui_dim "       依赖: ${deps:-无}" "developer"
      printf '\n'
    done
  done
}

ccq_build_execution_plan() {
  local original=("$@")
  ccq_dependency_closure "${original[@]}"
}

ccq_confirm_execution_plan() {
  local original_count="${1:-0}"
  shift || true
  local original=()
  while [ "${original_count}" -gt 0 ] && [ "$#" -gt 0 ]; do
    original+=("$1")
    shift
    original_count=$((original_count - 1))
  done
  local final=("$@")
  local auto_added=() step_id idx=0 choice step_name

  for step_id in "${final[@]}"; do
    ccq_array_contains "${step_id}" "${original[@]}" || auto_added+=("${step_id}")
  done

  if [ "${#auto_added[@]}" -gt 0 ]; then
    ccq_ui_warning "以下依赖将自动纳入执行计划（已安装项会自动跳过）："
    for step_id in "${auto_added[@]}"; do
      step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
      ccq_ui_info "  + ${step_name}（自动补齐）"
    done
  fi

  ccq_ui_primary "执行计划："
  for step_id in "${final[@]}"; do
    idx=$((idx + 1))
    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    ccq_ui_info "  ${idx}. ${step_name}"
  done

  if [ ! -r /dev/tty ]; then
    ccq_ui_warning "非交互环境无法确认执行计划，已取消"
    return 1
  fi

  choice="$(ccq_prompt_single "确认执行以上计划？" 0 "是，开始执行" "否，取消")" || return 1
  [ "${choice}" = "0" ]
}

ccq_show_final_summary() {
  local executed=("$@")
  local success=0 skipped=0 failed=0 unsupported=0 manual=0 step_id step_status step_name version data status_text
  local rows=()

  printf '\n'
  for step_id in "${executed[@]}"; do
    step_status="$(ccq_state_get_status "${step_id}" 2>/dev/null || printf 'Skipped')"
    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    data="$(ccq_state_get_data "${step_id}" 2>/dev/null || true)"
    version="$(ccq_result_field_from_text "${data}" "Version" 2>/dev/null || true)"
    [ -n "${version}" ] || version='-'

    case "${step_status}" in
      Success) success=$((success + 1)) ;;
      Skipped) skipped=$((skipped + 1)) ;;
      Failed) failed=$((failed + 1)) ;;
      Unsupported) unsupported=$((unsupported + 1)) ;;
      ManualRequired) manual=$((manual + 1)) ;;
    esac

    status_text="$(ccq_summary_status_text "${step_status}")"
    rows+=("${step_name}	${status_text}	${version}")
  done

  if [ "${#rows[@]}" -gt 0 ]; then
    ccq_show_install_summary "${rows[@]}"
  fi

  printf '\n'
  ccq_ui_primary "安装统计："
  ccq_ui_success "  成功: ${success}"
  [ "${skipped}" -gt 0 ] && ccq_ui_warning "  跳过: ${skipped}"
  [ "${failed}" -gt 0 ] && ccq_ui_danger "  失败: ${failed}"
  if [ $((unsupported + manual)) -gt 0 ]; then
    ccq_ui_warning "  需手动处理: $((unsupported + manual))"
  fi

  if [ "${failed}" -eq 0 ]; then
    printf '\n'
    ccq_ui_primary "快速开始：" "developer"
    ccq_ui_primary "管理面板（可选）：" "developer"
    ccq_ui_info "  ccq            - 启动 Claude Code Quickstart 管理控制台" "developer"
    ccq_ui_info "  工具管理       - 按需安装 Claude Code / Codex / Pi" "developer"
    ccq_ui_info "  扩展管理       - 维护 Pi package 扩展" "developer"
  else
    printf '\n'
    ccq_ui_warning "安装完成，但有 ${failed} 个步骤失败"
    ccq_ui_info "重新运行安装器可重试失败步骤" "developer"
  fi

  printf '\n'
}

ccq_invoke_grouped_install() {
  local skip_confirmation=0
  if [ "${1:-}" = "--skip-confirmation" ]; then
    skip_confirmation=1
    shift
  fi

  local selected=("$@")
  local plan_text step_id
  local ordered=()
  [ "${#selected[@]}" -gt 0 ] || { ccq_ui_warning "未选择任何步骤"; return 0; }

  plan_text="$(ccq_build_execution_plan "${selected[@]}")" || { ccq_ui_warning "无法生成执行计划"; return 1; }
  ordered=( ${plan_text} )

  if [ "${#ordered[@]}" -eq 0 ]; then
    ccq_ui_success "所有选定步骤已安装，无需操作"
    return 0
  fi

  if [ "${skip_confirmation}" != "1" ]; then
    ccq_confirm_execution_plan "${#selected[@]}" "${selected[@]}" "${ordered[@]}" || { ccq_ui_warning "安装已取消"; return 0; }
  fi

  local total="${#ordered[@]}" step_index=0 step_name step_description
  for step_id in "${ordered[@]}"; do
    step_index=$((step_index + 1))
    step_name="$(ccq_get_step_field "${step_id}" StepName 2>/dev/null || printf '%s' "${step_id}")"
    step_description="$(ccq_get_step_field "${step_id}" Description 2>/dev/null || true)"
    printf '\n'
    ccq_ui_primary "步骤 ${step_index} / ${total}: ${step_name}"
    ccq_ui_info "🔄 执行步骤: ${step_name} (安装)"
    [ -n "${step_description}" ] && ccq_ui_dim "     ${step_description}" "developer"
    ccq_invoke_step_lifecycle "${step_id}" || true
  done

  ccq_show_final_summary "${ordered[@]}"
}


ccq_confirm_basic_install_plan() {
  ccq_ui_primary "本次将检查/安装以下基础环境组件："
  printf '\n'
  ccq_ui_info "  1. Homebrew（缺失时执行官方安装脚本）"
  ccq_ui_info "  2. nvm / Node.js（Basic 必需）"
  ccq_ui_info "  3. Git（Basic 必需）"
  ccq_ui_info "  4. ccq 管理控制台（安装器末尾确认下载）"
  ccq_ui_dim "     Claude Code / Codex / Pi 将在 ccq「工具管理」中按需安装"
  printf '\n'

  local choice
  choice="$(ccq_prompt_single "确认开始安装基础环境？" 0 "是，开始安装" "否，取消")" || return 1
  [ "${choice}" = "0" ]
}

ccq_main() {
  ccq_parse_args "$@"
  ccq_load_core
  ccq_load_step_modules

  if [ "${CCQ_PARAM_LIST_STEPS}" = "1" ]; then
    ccq_show_step_list
    return 0
  fi

  ccq_show_banner "Claude Code Quickstart"
  ccq_ui_info "一键搭建 ccq 运行基础环境（Node.js / Git），Claude Code / Codex / Pi 由工具管理按需安装" "developer"

  if ! ccq_confirm_basic_install_plan; then
    ccq_ui_info "安装已取消"
    return 0
  fi

  # 前置环境检测（macOS 12+ / Homebrew / Node.js 检测+nvm 兜底，zsh 单运行时）
  ccq_preflight || return 1

  # 旧 Profile 标记块迁移清理（幂等，无残留则 no-op）
  ccq_cleanup_legacy_profile_blocks

  # 基础环境直装（NodeJS / Git），Claude Code / Codex / Pi 交由 ccq 工具管理安装
  ccq_ui_primary "开始安装基础环境" "developer"
  ccq_invoke_grouped_install --skip-confirmation $(ccq_get_group_step_ids Basic)

  # ccq 可执行文件下载确认（TDR-6；install 模式保留首次下载确认）
  # 完整 install 沿用既有语义：ccq 下载失败只告警，不把基础环境安装判为失败；
  # 失败返回值由专用入口（Download-Tui.zsh）作为退出码使用。
  printf '\n'
  ccq_confirm_executable_download install || true
}



ccq_main "$@"