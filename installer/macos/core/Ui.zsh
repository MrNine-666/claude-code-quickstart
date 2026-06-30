#!/usr/bin/env zsh
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
