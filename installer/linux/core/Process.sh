#!/usr/bin/env bash
# Process.sh - Linux 命令执行与 PATH 刷新
# 功能: 命令探测、原生命令执行（输出到 stderr，不污染 step 结果字段）、单条 sudo、当前会话 PATH 刷新

ccq_command_exists() {
  command -v "${1:-}" >/dev/null 2>&1
}

ccq_run_native_command() {
  # step 函数的 stdout 是 key=value 结果，命令输出一律转到 stderr 供用户查看。
  "$@" >&2
}

ccq_format_command() {
  local arg out=""
  for arg in "$@"; do
    out="${out:+${out} }${arg}"
  done
  printf '%s' "${out}"
}

ccq_sudo_run() {
  # 只对单条包管理命令提权；sudo 自行经 /dev/tty 询问密码。
  # 返回: 命令退出码；sudo 不存在时返回 126（调用方据此进入 ManualRequired）。
  if ! ccq_command_exists sudo; then
    return 126
  fi
  ccq_ui_info "执行: sudo $(ccq_format_command "$@")" >&2
  sudo -- "$@" >&2
}

ccq_refresh_path() {
  # 当前会话补充 ~/.local/bin、fnm 与 nvm default，使安装后的命令立即可见。
  case ":${PATH}:" in
    *":${HOME}/.local/bin:"*) ;;
    *) PATH="${HOME}/.local/bin:${PATH}" ;;
  esac

  if ccq_command_exists fnm; then
    eval "$(fnm env --shell bash 2>/dev/null)" 2>/dev/null || true
  fi

  local nvm_dir="${NVM_DIR:-}"
  if [ -z "${nvm_dir}" ]; then
    if [ -n "${XDG_CONFIG_HOME:-}" ]; then nvm_dir="${XDG_CONFIG_HOME%/}/nvm"; else nvm_dir="${HOME}/.nvm"; fi
  fi
  nvm_dir="${nvm_dir%/}"
  if [ -s "${nvm_dir}/nvm.sh" ]; then
    export NVM_DIR="${nvm_dir}"
    . "${nvm_dir}/nvm.sh" >/dev/null 2>&1 || true
    if ccq_command_exists nvm; then
      nvm use --silent default >/dev/null 2>&1 || true
    fi
  fi
  hash -r 2>/dev/null || true
  export PATH
}
