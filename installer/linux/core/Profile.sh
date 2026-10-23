#!/usr/bin/env bash
# Profile.sh - Linux shell profile 受管片段
# 功能: 以标记块幂等地把 ~/.local/bin 写入 ~/.bashrc（及已存在的 ~/.zshrc）；
#       fish 等其他登录 shell 只打印手动指引，不修改其配置。

CCQ_PROFILE_BLOCK_BEGIN='# >>> ccq local-bin >>>'
CCQ_PROFILE_BLOCK_END='# <<< ccq local-bin <<<'

ccq_profile_block_body() {
  # 单引号保留 $HOME/$PATH，交由用户 shell 展开；重复执行时 PATH 已含则不再追加。
  printf '%s\n' 'case ":${PATH}:" in *":${HOME}/.local/bin:"*) ;; *) export PATH="${HOME}/.local/bin:${PATH}" ;; esac'
}

ccq_profile_set_block() {
  # 已有标记块则原位替换，否则追加；写入经同目录临时文件 + mv（沿用原权限），避免截断用户配置。
  local profile_path="$1" body tmp_path in_block=0 replaced=0 line
  # 符号链接（dotfile 管理器）写到真实目标，mv 不能替换掉链接本身。
  if [ -L "${profile_path}" ]; then
    profile_path="$(readlink -f "${profile_path}")" || return 1
  fi
  body="$(ccq_profile_block_body)"
  tmp_path="${profile_path}.ccq-tmp.$$"

  {
    if [ -f "${profile_path}" ]; then
      while IFS= read -r line || [ -n "${line}" ]; do
        if [ "${in_block}" = "1" ]; then
          [ "${line}" = "${CCQ_PROFILE_BLOCK_END}" ] && in_block=0
          continue
        fi
        if [ "${line}" = "${CCQ_PROFILE_BLOCK_BEGIN}" ]; then
          if [ "${replaced}" = "0" ]; then
            printf '%s\n%s\n%s\n' "${CCQ_PROFILE_BLOCK_BEGIN}" "${body}" "${CCQ_PROFILE_BLOCK_END}"
            replaced=1
          fi
          in_block=1
          continue
        fi
        printf '%s\n' "${line}"
      done <"${profile_path}"
    fi
    if [ "${replaced}" = "0" ]; then
      printf '\n%s\n%s\n%s\n' "${CCQ_PROFILE_BLOCK_BEGIN}" "${body}" "${CCQ_PROFILE_BLOCK_END}"
    fi
  } >"${tmp_path}" || { rm -f "${tmp_path}"; return 1; }

  if [ -f "${profile_path}" ] && [ "$(cat "${tmp_path}")" = "$(cat "${profile_path}")" ]; then
    rm -f "${tmp_path}"
    return 0
  fi
  [ -f "${profile_path}" ] && chmod --reference="${profile_path}" "${tmp_path}" 2>/dev/null
  mv -f "${tmp_path}" "${profile_path}" || { rm -f "${tmp_path}"; return 1; }
}

ccq_profile_login_shell() {
  basename "${SHELL:-bash}"
}

ccq_profile_ensure_local_bin() {
  # 返回 0 = 已写入（或已存在）受管片段；失败只返回 1，由调用方告警。
  local rc_file failed=0 shell_name
  for rc_file in "${HOME}/.bashrc" "${HOME}/.zshrc"; do
    # ~/.bashrc 始终处理；~/.zshrc 仅在已存在时处理，不替用户创建 zsh 配置。
    [ "${rc_file}" = "${HOME}/.zshrc" ] && [ ! -f "${rc_file}" ] && continue
    if ccq_profile_set_block "${rc_file}"; then
      ccq_ui_dim "  已确保 ~/.local/bin 写入 ${rc_file}"
    else
      ccq_ui_warning "无法写入 ${rc_file}，请手动把 ~/.local/bin 加入 PATH"
      failed=1
    fi
  done

  shell_name="$(ccq_profile_login_shell)"
  case "${shell_name}" in
    bash|zsh) ;;
    fish)
      ccq_ui_warning "检测到登录 shell 为 fish，未自动修改其配置；请手动执行: fish_add_path ~/.local/bin"
      ;;
    *)
      ccq_ui_warning "检测到登录 shell 为 ${shell_name}，未自动修改其配置；请手动把 ~/.local/bin 加入 PATH"
      ;;
  esac
  [ "${failed}" = "0" ]
}
