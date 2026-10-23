#!/usr/bin/env bash
# Test-LinuxInstaller.sh - Linux installer 行为测试（容器内运行，不安装软件、不访问网络）
#
# 用法:
#   bash installer/contracts/Test-LinuxInstaller.sh [--expectations <file>] [--dist <dir>] [--host-safe]
#
#   --expectations  由宿主执行 node installer/contracts/linux-platform-expectations.mjs 生成的期望表；
#                   省略时若本机有 node 则现场生成，否则跳过「与 linux-platforms.json 对照」部分。
#   --dist          额外检查 <dir>/install.sh、<dir>/download-tui.sh 的分派与临时文件清理（缺失则 SKIP）。
#   --host-safe     非容器宿主（如 Windows Git Bash）：跳过真实 root 与切换普通用户阶段。
#
# 容器内以 root 启动时：先以真实 root 验证拒绝，再用 setpriv / runuser / su 切换到普通用户运行其余用例；
# 都不可用时继续以 root 运行，并用 fake id 模拟普通用户（输出中会注明）。
# 全部用例使用 fake uname/id/ldd/getconf/sudo/包管理器/curl/nvm/node/git 与临时 HOME。

set -u

script_dir="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
REPO="$(cd "${script_dir}/../.." && pwd)"
LINUX_ROOT="${REPO}/installer/linux"
EXPECTATIONS=""
DIST_DIR=""
HOST_SAFE=0
ORIGINAL_ARGS=("$@")

while [ "$#" -gt 0 ]; do
  case "$1" in
    --expectations) EXPECTATIONS="${2:-}"; shift 2 ;;
    --dist) DIST_DIR="${2:-}"; shift 2 ;;
    --host-safe) HOST_SAFE=1; shift ;;
    -h|--help) sed -n '2,16p' "${BASH_SOURCE[0]}"; exit 0 ;;
    *) printf '未知参数: %s\n' "$1" >&2; exit 2 ;;
  esac
done
[ -z "${EXPECTATIONS}" ] || EXPECTATIONS="$(cd "$(dirname "${EXPECTATIONS}")" && pwd)/$(basename "${EXPECTATIONS}")"
[ -z "${DIST_DIR}" ] || DIST_DIR="$(cd "${DIST_DIR}" 2>/dev/null && pwd || printf '%s' "${DIST_DIR}")"

PASS_COUNT=0
FAIL_COUNT=0
SKIP_COUNT=0
pass() { PASS_COUNT=$((PASS_COUNT + 1)); printf '[PASS] %s\n' "$1"; }
fail() { FAIL_COUNT=$((FAIL_COUNT + 1)); printf '[FAIL] %s\n' "$1"; [ -z "${2:-}" ] || printf '%s\n' "$2" | sed 's/^/       /'; }
skip() { SKIP_COUNT=$((SKIP_COUNT + 1)); printf '[SKIP] %s\n' "$1"; }
check() {
  # check <名称> <命令...>：命令成功即 PASS
  local name="$1"; shift
  if "$@"; then pass "${name}"; else fail "${name}" "${RUN_OUT:+$(tail -n 15 "${RUN_OUT}" 2>/dev/null)}"; fi
}
summary_and_exit() {
  printf '\n结果: %s passed, %s failed, %s skipped\n' "${PASS_COUNT}" "${FAIL_COUNT}" "${SKIP_COUNT}"
  [ "${FAIL_COUNT}" -eq 0 ]
  exit $?
}

REAL_ID="$(command -v id)"

# ─── 阶段 0：容器 root —— 真实 root 拒绝，然后切换普通用户 ────────────────────

if [ "${HOST_SAFE}" = "0" ] && [ -z "${CCQ_TEST_CHILD:-}" ] && [ "$("${REAL_ID}" -u)" = "0" ]; then
  printf '═══ 阶段 0：以真实 root 运行 ═══\n'
  root_tmp="$(mktemp -d)"
  printf 'ID=ubuntu\nVERSION_ID="24.04"\nNAME="Ubuntu"\n' >"${root_tmp}/os-release"
  for entry in Install.sh Download-Tui.sh; do
    RUN_OUT="${root_tmp}/${entry}.out"
    mkdir -p "${root_tmp}/home-${entry}"
    env HOME="${root_tmp}/home-${entry}" CCQ_OS_RELEASE_FILE="${root_tmp}/os-release" \
      CCQ_TTY_IN=/dev/null CCQ_TTY_OUT=/dev/null bash "${LINUX_ROOT}/${entry}" >"${RUN_OUT}" 2>&1
    rc=$?
    check "real-root.${entry}.rejected" [ "${rc}" -ne 0 ]
    check "real-root.${entry}.message" grep -q '请勿以 root 运行' "${RUN_OUT}"
    check "real-root.${entry}.no-home-mutation" [ -z "$(ls -A "${root_tmp}/home-${entry}")" ]
  done
  rm -rf "${root_tmp}"
  unset RUN_OUT

  child_status=""
  if command -v setpriv >/dev/null 2>&1; then
    printf '\n═══ 切换普通用户（setpriv uid=1000）═══\n'
    setpriv --reuid=1000 --regid=1000 --clear-groups \
      env CCQ_TEST_CHILD=1 HOME=/tmp TMPDIR=/tmp bash "${BASH_SOURCE[0]}" "${ORIGINAL_ARGS[@]}"
    child_status=$?
  elif command -v runuser >/dev/null 2>&1 && { id ccqtest >/dev/null 2>&1 || useradd -m ccqtest >/dev/null 2>&1; }; then
    printf '\n═══ 切换普通用户（runuser ccqtest）═══\n'
    runuser -u ccqtest -- env CCQ_TEST_CHILD=1 HOME=/tmp TMPDIR=/tmp bash "${BASH_SOURCE[0]}" "${ORIGINAL_ARGS[@]}"
    child_status=$?
  elif command -v su >/dev/null 2>&1 && { id ccqtest >/dev/null 2>&1 || useradd -m ccqtest >/dev/null 2>&1; }; then
    printf '\n═══ 切换普通用户（su ccqtest）═══\n'
    su ccqtest -s /bin/bash -c "$(printf '%q ' env CCQ_TEST_CHILD=1 HOME=/tmp TMPDIR=/tmp bash "${BASH_SOURCE[0]}" "${ORIGINAL_ARGS[@]}")"
    child_status=$?
  fi

  if [ -n "${child_status}" ]; then
    [ "${child_status}" -eq 0 ] || FAIL_COUNT=$((FAIL_COUNT + 1))
    summary_and_exit
  fi
  printf '\n[INFO] setpriv / runuser / su 均不可用：继续以 root 运行，并用 fake id 模拟普通用户 (uid=1000)\n'
  export CCQ_TEST_SIMULATED_UID=1000
fi

# ─── 测试环境 ────────────────────────────────────────────────────────────────

WORK="$(mktemp -d "${TMPDIR:-/tmp}/ccq-linux-test.XXXXXX")" || exit 1
trap 'rm -rf "${WORK}"' EXIT
SYSBIN="${WORK}/sysbin"      # 真实基础工具的 wrapper（隔离宿主上的 git/node/wget 等）
FAKEBIN="${WORK}/fakebin"    # uname / id / ldd / getconf / curl
SUDOBIN="${WORK}/sudobin"
PMBIN="${WORK}/pmbin"        # apt-get / dnf / pacman
NODEBIN="${WORK}/nodebin"    # 达标 node v22 + npm
OLDNODEBIN="${WORK}/oldnodebin"
GITBIN="${WORK}/gitbin"      # 已安装的 git
SERVE="${WORK}/serve"        # fake curl 按 URL basename 提供的文件
CCQ_TEST_LOG="${WORK}/calls.log"
mkdir -p "${SYSBIN}" "${FAKEBIN}" "${SUDOBIN}" "${PMBIN}" "${NODEBIN}" "${OLDNODEBIN}" "${GITBIN}" "${SERVE}" "${WORK}/tmp"
SHEBANG="#!${BASH}"

for tool in bash cat grep sed gzip mktemp head cut tr wc sort dirname basename readlink chmod mv rm mkdir sleep cp env ls touch tail stat; do
  tool_path="$(command -v "${tool}" 2>/dev/null || true)"
  if [ -z "${tool_path}" ]; then
    printf '[INFO] 宿主缺少 %s，相关路径可能失败\n' "${tool}"
    continue
  fi
  printf '%s\nexec %q "$@"\n' "${SHEBANG}" "${tool_path}" >"${SYSBIN}/${tool}"
done

write_fake() {
  local path="$1"
  { printf '%s\n' "${SHEBANG}"; cat; } >"${path}"
  chmod +x "${path}"
}

write_fake "${FAKEBIN}/uname" <<'EOF'
case "${1:-}" in
  -m) printf '%s\n' "${FAKE_UNAME_M:-x86_64}" ;;
  *) printf '%s\n' "${FAKE_UNAME_S:-Linux}" ;;
esac
EOF
write_fake "${FAKEBIN}/id" <<EOF
if [ "\${1:-}" = "-u" ] && [ -n "\${FAKE_UID:-}" ]; then printf '%s\n' "\${FAKE_UID}"; exit 0; fi
exec $(printf '%q' "${REAL_ID}") "\$@"
EOF
write_fake "${FAKEBIN}/ldd" <<'EOF'
if [ "${FAKE_LIBC:-glibc}" = "musl" ]; then printf 'musl libc (x86_64)\nVersion 1.2.5\n' >&2; exit 1; fi
printf 'ldd (GNU libc) 2.39\n'
EOF
write_fake "${FAKEBIN}/getconf" <<'EOF'
[ "${FAKE_LIBC:-glibc}" = "glibc" ] && [ "${1:-}" = "GNU_LIBC_VERSION" ] && { printf 'glibc 2.39\n'; exit 0; }
exit 1
EOF
write_fake "${FAKEBIN}/curl" <<'EOF'
# fake curl：按 URL basename 从 CCQ_TEST_SERVE 提供文件；从不访问网络。
output="" url=""
while [ "$#" -gt 0 ]; do
  case "$1" in
    -o) output="$2"; shift 2 ;;
    --connect-timeout|--max-time) shift 2 ;;
    -*) shift ;;
    *) url="$1"; shift ;;
  esac
done
printf 'curl %s\n' "${url}" >>"${CCQ_TEST_LOG}"
source_file="${CCQ_TEST_SERVE}/${url##*/}"
[ -f "${source_file}" ] || exit 22
if [ -n "${output}" ]; then cat "${source_file}" >"${output}"; else cat "${source_file}"; fi
EOF
write_fake "${SUDOBIN}/sudo" <<'EOF'
[ "${1:-}" = "--" ] && shift
printf 'sudo %s\n' "$*" >>"${CCQ_TEST_LOG}"
exec "$@"
EOF
for pm in apt-get dnf pacman; do
  write_fake "${PMBIN}/${pm}" <<EOF
printf '%s %s\n' "${pm}" "\$*" >>"\${CCQ_TEST_LOG}"
[ "\${FAKE_PM_FAIL:-0}" = "1" ] && exit 1
case " \$* " in
  *" git "*) cp "${GITBIN}/git" "\${CCQ_TEST_INSTALL_DIR}/git" ;;
esac
exit 0
EOF
done
write_fake "${GITBIN}/git" <<'EOF'
# fake git：--version 与 config --global（存于 $HOME/.fake-gitconfig）
store="${HOME}/.fake-gitconfig"
case "${1:-}" in
  --version) printf 'git version 2.45.1\n' ;;
  config)
    shift; [ "${1:-}" = "--global" ] && shift
    if [ "${1:-}" = "--get" ]; then
      grep -m1 "^$2=" "${store}" 2>/dev/null | cut -d= -f2- | grep . || exit 1
    else
      printf '%s=%s\n' "$1" "$2" >>"${store}"
    fi
    ;;
  *) exit 1 ;;
esac
EOF
printf '%s\necho v22.11.0\n' "${SHEBANG}" >"${NODEBIN}/node"
printf '%s\necho 10.9.0\n' "${SHEBANG}" >"${NODEBIN}/npm"
printf '%s\necho v16.20.0\n' "${SHEBANG}" >"${OLDNODEBIN}/node"
printf '%s\necho 8.19.0\n' "${SHEBANG}" >"${OLDNODEBIN}/npm"
chmod +x "${NODEBIN}"/* "${OLDNODEBIN}"/*

# fake nvm 官方安装脚本：写入 $NVM_DIR/nvm.sh，nvm install 生成 fake node/npm。
cat >"${SERVE}/install.sh" <<EOF
mkdir -p "\${NVM_DIR}"
cat >"\${NVM_DIR}/nvm.sh" <<'NVM'
nvm() {
  printf 'nvm %s\n' "\$*" >>"\${CCQ_TEST_LOG}"
  local bin="\${NVM_DIR}/versions/node/v22.11.0/bin"
  case "\$1" in
    install)
      mkdir -p "\${bin}"
      printf '%s\necho v22.11.0\n' "${SHEBANG}" >"\${bin}/node"
      printf '%s\necho 10.9.0\n' "${SHEBANG}" >"\${bin}/npm"
      chmod +x "\${bin}/node" "\${bin}/npm"
      ;;
    use) [ -d "\${bin}" ] && PATH="\${bin}:\${PATH}" ;;
  esac
  return 0
}
NVM
EOF

# ccq fixtures：raw = 新版本 2.0.0；gzip = raw 的 gzip；corrupt = 截断的 gzip
printf '%s\necho "ccq 2.0.0"\n' "${SHEBANG}" >"${WORK}/ccq-raw"
printf '%s\necho "ccq 1.0.0"\n' "${SHEBANG}" >"${WORK}/ccq-old"
chmod +x "${WORK}/ccq-raw" "${WORK}/ccq-old"
HAVE_GZIP=0
if command -v gzip >/dev/null 2>&1; then
  HAVE_GZIP=1
  gzip -c "${WORK}/ccq-raw" >"${WORK}/ccq-raw.gz"
  head -c $(($(wc -c <"${WORK}/ccq-raw.gz") - 6)) "${WORK}/ccq-raw.gz" >"${WORK}/ccq-corrupt.gz"
fi

printf 'Linux version 6.8.0-45-generic (buildd@lcy02) (gcc 13.2.0) #45-Ubuntu SMP\n' >"${WORK}/proc-native"
printf 'Linux version 4.4.0-19041-Microsoft (Microsoft@Microsoft.com) (gcc version 5.4.0 (GCC) ) #1237-Microsoft\n' >"${WORK}/proc-wsl1"
printf 'Linux version 5.15.153.1-microsoft-standard-WSL2 (root@941d701f84f1) (gcc (GCC) 12.2.0) #1 SMP\n' >"${WORK}/proc-wsl2"

write_os_release() {
  # write_os_release <path> <ID> <VERSION_ID|-> <NAME> <ID_LIKE|->
  {
    printf '# fixture\n\n'
    printf 'NAME="%s"\n' "$4"
    printf 'ID=%s\n' "$2"
    [ "$3" = "-" ] || printf "VERSION_ID='%s'\n" "$3"
    [ "$5" = "-" ] || printf 'ID_LIKE="%s"\n' "$5"
    printf 'PRETTY_NAME="%s %s"\n' "$4" "${3#-}"
  } >"$1"
}
write_os_release "${WORK}/os-ubuntu" ubuntu 24.04 Ubuntu debian
write_os_release "${WORK}/os-debian" debian 13 "Debian GNU/Linux" -
write_os_release "${WORK}/os-fedora" fedora 44 "Fedora Linux" -
write_os_release "${WORK}/os-centos" centos 10 "CentOS Stream" "rhel fedora"
write_os_release "${WORK}/os-arch" arch - "Arch Linux" -
write_os_release "${WORK}/os-mint" linuxmint 22 "Linux Mint" "ubuntu debian"

base_path() {
  # base_path [sudo] [pm] [node|oldnode] [git]
  local path="${FAKEBIN}" item
  for item in "$@"; do
    case "${item}" in
      sudo) path="${path}:${SUDOBIN}" ;;
      pm) path="${path}:${PMBIN}" ;;
      node) path="${path}:${NODEBIN}" ;;
      oldnode) path="${path}:${OLDNODEBIN}" ;;
      git) path="${path}:${GITBIN}" ;;
    esac
  done
  printf '%s' "${path}:${SYSBIN}"
}

run_entry() {
  # run_entry <名称> <Install.sh|Download-Tui.sh|绝对路径> [VAR=value...] [-- 参数...]
  # 读取 ANSWERS（/dev/tty 输入）与 RUN_PATH；结果: RUN_RC、RUN_OUT、RUN_TTY、RUN_HOME、RUN_DIR
  local name="$1" entry="$2" script; shift 2
  local -a assigns=() args=()
  while [ "$#" -gt 0 ]; do
    if [ "$1" = "--" ]; then shift; args=("$@"); break; fi
    assigns+=("$1"); shift
  done
  case "${entry}" in /*) script="${entry}" ;; *) script="${LINUX_ROOT}/${entry}" ;; esac
  RUN_DIR="${WORK}/run-${name}"
  RUN_HOME="${RUN_DIR}/home"
  RUN_OUT="${RUN_DIR}/out"
  RUN_TTY="${RUN_DIR}/tty"
  mkdir -p "${RUN_HOME}" "${RUN_DIR}/installed" "${RUN_DIR}/tmp"
  printf '%b' "${ANSWERS:-}" >"${RUN_DIR}/answers"
  : >"${CCQ_TEST_LOG}"
  env -i \
    ${SYSTEMROOT:+SYSTEMROOT="${SYSTEMROOT}"} ${WINDIR:+WINDIR="${WINDIR}"} \
    HOME="${RUN_HOME}" TMPDIR="${RUN_DIR}/tmp" TERM=dumb SHELL=/bin/bash LANG=C.UTF-8 \
    PATH="${RUN_PATH:-$(base_path sudo pm node git)}:${RUN_DIR}/installed" \
    CCQ_TEST_LOG="${CCQ_TEST_LOG}" CCQ_TEST_SERVE="${SERVE}" CCQ_TEST_INSTALL_DIR="${RUN_DIR}/installed" \
    CCQ_TTY_IN="${RUN_DIR}/answers" CCQ_TTY_OUT="${RUN_TTY}" \
    CCQ_OS_RELEASE_FILE="${WORK}/os-ubuntu" CCQ_PROC_VERSION_FILE="${WORK}/proc-native" \
    CCQ_OSTREE_BOOTED_FILE="${WORK}/no-ostree" \
    CCQ_RELEASE_DOWNLOAD_BASE_URL="https://example.invalid/releases/latest/download" \
    ${CCQ_TEST_SIMULATED_UID:+FAKE_UID="${CCQ_TEST_SIMULATED_UID}"} \
    "${assigns[@]}" "${BASH}" "${script}" "${args[@]}" >"${RUN_OUT}" 2>&1
  RUN_RC=$?
}

log_has() { grep -qxF -- "$1" "${CCQ_TEST_LOG}"; }
log_lacks() { ! grep -q -- "$1" "${CCQ_TEST_LOG}"; }
out_has() { grep -qF -- "$1" "${RUN_OUT}" "${RUN_TTY}" 2>/dev/null; }
home_untouched() { [ ! -e "${RUN_HOME}/.bashrc" ] && [ ! -e "${RUN_HOME}/.local" ] && [ ! -e "${RUN_HOME}/.nvm" ]; }
no_transfer_temps() { ! ls "${RUN_HOME}/.local/bin/" 2>/dev/null | grep -q 'download'; }

with_core() {
  # 在子 shell 中加载 Linux core 后执行命令（用 fake PATH，不触碰宿主）。
  (
    export PATH="$(base_path)" CCQ_TEST_LOG HOME="${WORK}/core-home"
    mkdir -p "${HOME}"
    CCQ_LINUX_ROOT="${LINUX_ROOT}"
    CCQ_TTY_IN=/nonexistent/tty CCQ_TTY_OUT=/nonexistent/tty
    source "${LINUX_ROOT}/core/Load.sh"
    ccq_load_core >/dev/null || exit 99
    "$@"
  )
}

printf '\n═══ 运行用户: uid=%s%s ═══\n' "$("${REAL_ID}" -u)" "${CCQ_TEST_SIMULATED_UID:+（fake id 模拟 uid=${CCQ_TEST_SIMULATED_UID}）}"

# ─── 1. 语法 ─────────────────────────────────────────────────────────────────

for file in "${LINUX_ROOT}"/*.sh "${LINUX_ROOT}"/core/*.sh "${LINUX_ROOT}"/steps/*.sh "${BASH_SOURCE[0]}"; do
  check "syntax.${file#"${REPO}/"}" bash -n "${file}"
done

# ─── 2. --list-steps / --help：无 TTY、root 下也可运行 ───────────────────────

for uid in "" 0; do
  label="${uid:+root}"; label="${label:-user}"
  ANSWERS="" run_entry "list-${label}" Install.sh CCQ_TTY_IN=/nonexistent/tty ${uid:+FAKE_UID=0} -- --list-steps
  check "list-steps.${label}.rc" [ "${RUN_RC}" -eq 0 ]
  check "list-steps.${label}.content" out_has '已注册的安装步骤'
  check "list-steps.${label}.steps" grep -q 'Node.js' "${RUN_OUT}"
  ANSWERS="" run_entry "help-${label}" Install.sh CCQ_TTY_IN=/nonexistent/tty ${uid:+FAKE_UID=0} -- --help
  check "help.install.${label}" [ "${RUN_RC}" -eq 0 ]
  ANSWERS="" run_entry "help-dl-${label}" Download-Tui.sh CCQ_TTY_IN=/nonexistent/tty ${uid:+FAKE_UID=0} -- --help
  check "help.download.${label}" [ "${RUN_RC}" -eq 0 ]
done
ANSWERS="" run_entry "unknown-arg" Install.sh -- --bogus
check "args.unknown.rc2" [ "${RUN_RC}" -eq 2 ]

# ─── 3. root 拒绝 / 无 TTY 拒绝（均不得有任何修改）────────────────────────────

for entry in Install.sh Download-Tui.sh; do
  ANSWERS="\n\n\n" run_entry "root-${entry}" "${entry}" FAKE_UID=0
  check "root.${entry}.rejected" [ "${RUN_RC}" -ne 0 ]
  check "root.${entry}.message" out_has '请勿以 root 运行'
  check "root.${entry}.no-mutation" home_untouched
  check "root.${entry}.no-calls" [ ! -s "${CCQ_TEST_LOG}" ]

  ANSWERS="" run_entry "notty-${entry}" "${entry}" CCQ_TTY_IN=/nonexistent/tty
  check "no-tty.${entry}.rejected" [ "${RUN_RC}" -ne 0 ]
  check "no-tty.${entry}.message" out_has '未检测到可交互终端'
  check "no-tty.${entry}.no-mutation" home_untouched
  check "no-tty.${entry}.no-calls" [ ! -s "${CCQ_TEST_LOG}" ]
done

# ─── 4. os-release 分类 ──────────────────────────────────────────────────────

classify_file() {
  with_core bash_classify "$1"
}
bash_classify() {
  CCQ_OS_RELEASE_FILE="$1"
  ccq_linux_detect_distribution >/dev/null 2>&1
  printf '%s %s %s' "${CCQ_LINUX_CLASS}" "${CCQ_LINUX_FAMILY:--}" "${CCQ_LINUX_PM:--}"
}

if [ -z "${EXPECTATIONS}" ] && command -v node >/dev/null 2>&1; then
  EXPECTATIONS="${WORK}/expectations.tsv"
  node "${REPO}/installer/contracts/linux-platform-expectations.mjs" >"${EXPECTATIONS}" || EXPECTATIONS=""
fi

if [ -n "${EXPECTATIONS}" ] && [ -f "${EXPECTATIONS}" ]; then
  sample_index=0
  while IFS=$'\t' read -r kind c1 c2 c3 c4 c5 c6 c7; do
    case "${kind}" in
      classify)
        sample_index=$((sample_index + 1))
        fixture="${WORK}/sample-${sample_index}"
        write_os_release "${fixture}" "${c1}" "${c2}" "${c3}" "${c4}"
        actual="$(classify_file "${fixture}")"
        expected="${c5} ${c6} ${c7}"
        if [ "${actual}" = "${expected}" ]; then pass "classify.contract.${c1}-${c2}-${c3// /_}"
        else fail "classify.contract.${c1}-${c2}-${c3// /_}" "expected=${expected} actual=${actual}"; fi
        ;;
      arch)
        actual="$(FAKE_UNAME_M="${c1}" with_core ccq_linux_arch)"
        check "arch.contract.${c1}" [ "${actual}" = "${c2}" ]
        ;;
    esac
  done <"${EXPECTATIONS}"
  check "classify.contract.samples-present" [ "${sample_index}" -ge 5 ]
else
  skip "classify.contract（无 --expectations 且无 node，无法对照 linux-platforms.json）"
fi

check "classify.missing-file" [ "$(classify_file "${WORK}/does-not-exist")" = "unsupported - -" ]
printf 'this line is not key=value\nID=ubuntu\n' >"${WORK}/os-malformed"
check "classify.malformed-line" [ "$(classify_file "${WORK}/os-malformed")" = "unsupported - -" ]
printf 'NAME="No Id"\nVERSION_ID=1\n' >"${WORK}/os-no-id"
check "classify.missing-id" [ "$(classify_file "${WORK}/os-no-id")" = "unsupported - -" ]
printf 'ID=$(touch %s/pwned-unquoted)\n' "${WORK}" >"${WORK}/os-inject-bare"
check "classify.injection.bare-rejected" [ "$(classify_file "${WORK}/os-inject-bare")" = "unsupported - -" ]
printf 'ID=ubuntu\nVERSION_ID="24.04"\nNAME="$(touch %s/pwned-quoted)"\n' "${WORK}" >"${WORK}/os-inject-quoted"
check "classify.injection.quoted-literal" [ "$(classify_file "${WORK}/os-inject-quoted")" = "official debian apt" ]
check "classify.injection.bare-never-executed" [ ! -e "${WORK}/pwned-unquoted" ]
check "classify.injection.quoted-never-executed" [ ! -e "${WORK}/pwned-quoted" ]
printf 'ID="ubuntu"\r\nVERSION_ID="24.04"\r\n' >"${WORK}/os-crlf"
check "classify.crlf" [ "$(classify_file "${WORK}/os-crlf")" = "official debian apt" ]

# 衍生版：警告 + 默认拒绝（Enter）不继续，且无修改
ANSWERS="\n" run_entry "derivative-decline" Install.sh CCQ_OS_RELEASE_FILE="${WORK}/os-mint"
check "derivative.warning" out_has '未经验证'
check "derivative.default-declines" [ "${RUN_RC}" -ne 0 ]
check "derivative.no-calls" [ ! -s "${CCQ_TEST_LOG}" ]
# 未知发行版：unsupported，不猜包管理器
printf 'ID=gentoo\nNAME="Gentoo"\n' >"${WORK}/os-gentoo"
ANSWERS="\n\n" run_entry "unknown-distro" Install.sh CCQ_OS_RELEASE_FILE="${WORK}/os-gentoo"
check "unknown-distro.rejected" [ "${RUN_RC}" -ne 0 ]
check "unknown-distro.message" out_has '无法识别的发行版'
check "unknown-distro.no-calls" [ ! -s "${CCQ_TEST_LOG}" ]

# ─── 5. WSL1 / musl / 未知架构：下载前拒绝 ───────────────────────────────────

for case_spec in "wsl1:CCQ_PROC_VERSION_FILE=${WORK}/proc-wsl1:WSL1" "musl:FAKE_LIBC=musl:musl" "arch:FAKE_UNAME_M=riscv64:不支持的处理器架构" "kernel:FAKE_UNAME_S=FreeBSD:不支持的平台"; do
  IFS=: read -r case_name case_env case_text <<<"${case_spec}"
  for entry in Install.sh Download-Tui.sh; do
    ANSWERS="\n\n\n" run_entry "reject-${case_name}-${entry}" "${entry}" "${case_env}"
    check "reject.${case_name}.${entry}.rc" [ "${RUN_RC}" -ne 0 ]
    check "reject.${case_name}.${entry}.message" out_has "${case_text}"
    check "reject.${case_name}.${entry}.no-download" log_lacks 'curl'
    check "reject.${case_name}.${entry}.no-mutation" home_untouched
  done
done
check "wsl2.detected" [ "$(CCQ_PROC_VERSION_FILE="${WORK}/proc-wsl2" with_core ccq_linux_wsl_kind)" = "wsl2" ]
check "wsl1.detected" [ "$(CCQ_PROC_VERSION_FILE="${WORK}/proc-wsl1" with_core ccq_linux_wsl_kind)" = "wsl1" ]

# ─── 6. 包管理器 argv（官方基线，node 已达标、git 缺失）──────────────────────

expected_argv() {
  # 输出期望 sudo 调用（来自期望表；无表时用内置值）
  local pm="$1"
  if [ -n "${EXPECTATIONS}" ] && [ -f "${EXPECTATIONS}" ]; then
    local kind name step argv
    while IFS=$'\t' read -r kind name step argv; do
      [ "${kind}" = "argv" ] && [ "${name}" = "${pm}" ] && printf 'sudo %s\n' "${argv}"
    done <"${EXPECTATIONS}"
  else
    case "${pm}" in
      apt) printf 'sudo apt-get update\nsudo apt-get install -y git\n' ;;
      dnf) printf 'sudo dnf install -y git\n' ;;
      pacman) printf 'sudo pacman -S --needed --noconfirm git\n' ;;
    esac
  fi
}

for spec in ubuntu:apt debian:apt fedora:dnf centos:dnf arch:pacman; do
  distro="${spec%%:*}"; pm="${spec#*:}"
  # 计划确认 Enter；sudo 确认 Enter；ccq 下载选 2（跳过）
  ANSWERS="\n\n2\n" RUN_PATH="$(base_path sudo pm node)" run_entry "pm-${distro}" Install.sh CCQ_OS_RELEASE_FILE="${WORK}/os-${distro}"
  check "pm.${distro}.rc" [ "${RUN_RC}" -eq 0 ]
  actual_sudo="$(grep '^sudo ' "${CCQ_TEST_LOG}")"
  check "pm.${distro}.argv" [ "${actual_sudo}" = "$(expected_argv "${pm}")" ]
  check "pm.${distro}.git-postflight" out_has '✅ Git 已安装'
  check "pm.${distro}.no-syu" log_lacks '-Syu'
done

# Pacman 失败 → ManualRequired + sudo pacman -Syu git 提示，不自动全系统升级
ANSWERS="\n\n2\n" RUN_PATH="$(base_path sudo pm node)" run_entry "pacman-fail" Install.sh CCQ_OS_RELEASE_FILE="${WORK}/os-arch" FAKE_PM_FAIL=1
check "pacman-fail.rc-nonzero" [ "${RUN_RC}" -ne 0 ]
check "pacman-fail.manual-required" out_has '需手动处理'
check "pacman-fail.hint" out_has 'sudo pacman -Syu git'
check "pacman-fail.only-needed" [ "$(grep '^pacman ' "${CCQ_TEST_LOG}")" = "pacman -S --needed --noconfirm git" ]

# APT 失败 → Failed，不报告成功
ANSWERS="\n\n2\n" RUN_PATH="$(base_path sudo pm node)" run_entry "apt-fail" Install.sh FAKE_PM_FAIL=1
check "apt-fail.rc-nonzero" [ "${RUN_RC}" -ne 0 ]
check "apt-fail.failed" out_has '安装失败'

# 无 sudo → ManualRequired，不调用包管理器
ANSWERS="\n2\n" RUN_PATH="$(base_path pm node)" run_entry "no-sudo" Install.sh
check "no-sudo.rc-nonzero" [ "${RUN_RC}" -ne 0 ]
check "no-sudo.manual" out_has 'sudo 不可用'
check "no-sudo.no-pm-call" log_lacks 'apt-get'

# 缺包管理器 → ManualRequired，不猜测其他路径
ANSWERS="\n2\n" RUN_PATH="$(base_path sudo node)" run_entry "no-pm" Install.sh CCQ_OS_RELEASE_FILE="${WORK}/os-fedora"
check "no-pm.rc-nonzero" [ "${RUN_RC}" -ne 0 ]
check "no-pm.manual" out_has '缺少预期的包管理器 dnf'
check "no-pm.no-sudo-call" log_lacks 'sudo'

# 用户拒绝 sudo → ManualRequired
ANSWERS="\n2\n2\n" RUN_PATH="$(base_path sudo pm node)" run_entry "sudo-declined" Install.sh
check "sudo-declined.rc-nonzero" [ "${RUN_RC}" -ne 0 ]
check "sudo-declined.no-sudo-call" log_lacks 'sudo'

# ─── 7. Node / Git 已达标跳过；Node 缺失走 nvm 兜底 ───────────────────────────

mkdir -p "${WORK}/run-all-ready/home"
printf 'init.defaultBranch=main\ncore.quotepath=false\n' >"${WORK}/run-all-ready/home/.fake-gitconfig"
ANSWERS="\n2\n" RUN_PATH="$(base_path sudo pm node git)" run_entry "all-ready" Install.sh
check "ready.rc" [ "${RUN_RC}" -eq 0 ]
check "ready.skipped" [ "$(grep -c '组件已安装，跳过安装' "${RUN_OUT}")" -eq 2 ]
check "ready.no-sudo" log_lacks 'sudo'
check "ready.no-nvm" log_lacks 'nvm'

ANSWERS="\n2\n" RUN_PATH="$(base_path sudo pm oldnode git)" run_entry "nvm-fallback" Install.sh
check "nvm.rc" [ "${RUN_RC}" -eq 0 ]
check "nvm.pinned-script" log_has 'curl https://raw.githubusercontent.com/nvm-sh/nvm/v0.40.4/install.sh'
check "nvm.install-lts" log_has 'nvm install --lts'
check "nvm.node-in-home" [ -x "${RUN_HOME}/.nvm/versions/node/v22.11.0/bin/node" ]
check "nvm.no-system-node" log_lacks 'nodejs'

# ─── 8. ccq handoff（Download-Tui.sh，fake curl 提供本地文件）────────────────

serve_ccq() {
  # serve_ccq <arch> <gzip源|-> <raw源|->
  rm -f "${SERVE}"/ccq-linux-*
  [ "$2" = "-" ] || cp "$2" "${SERVE}/ccq-linux-$1.gz"
  [ "$3" = "-" ] || cp "$3" "${SERVE}/ccq-linux-$1"
}
ccq_target() { printf '%s/.local/bin/ccq' "${RUN_HOME}"; }
install_old_ccq() { mkdir -p "${RUN_HOME}/.local/bin"; cp "${WORK}/ccq-old" "${RUN_HOME}/.local/bin/ccq"; chmod +x "${RUN_HOME}/.local/bin/ccq"; }

if [ "${HAVE_GZIP}" = "1" ]; then
  serve_ccq x64 "${WORK}/ccq-raw.gz" "${WORK}/ccq-raw"
  ANSWERS="" run_entry "ccq-fresh" Download-Tui.sh
  check "ccq.fresh.rc" [ "${RUN_RC}" -eq 0 ]
  check "ccq.fresh.single-transfer" [ "$(grep -c '^curl ' "${CCQ_TEST_LOG}")" -eq 1 ]
  check "ccq.fresh.gzip-url" log_has "curl https://example.invalid/releases/latest/download/ccq-linux-x64.gz"
  check "ccq.fresh.bytes" [ "$(cat "$(ccq_target)")" = "$(cat "${WORK}/ccq-raw")" ]
  check "ccq.fresh.executable" [ -x "$(ccq_target)" ]
  check "ccq.fresh.no-temps" no_transfer_temps
  check "ccq.fresh.profile" grep -qF '# >>> ccq local-bin >>>' "${RUN_HOME}/.bashrc"

  serve_ccq arm64 "${WORK}/ccq-raw.gz" "${WORK}/ccq-raw"
  ANSWERS="" run_entry "ccq-arm64" Download-Tui.sh FAKE_UNAME_M=aarch64
  check "ccq.arm64.asset" log_has "curl https://example.invalid/releases/latest/download/ccq-linux-arm64.gz"

  serve_ccq x64 "${WORK}/ccq-corrupt.gz" "${WORK}/ccq-raw"
  ANSWERS="" run_entry "ccq-corrupt" Download-Tui.sh
  check "ccq.corrupt-gzip.rc" [ "${RUN_RC}" -eq 0 ]
  check "ccq.corrupt-gzip.raw-fallback" log_has "curl https://example.invalid/releases/latest/download/ccq-linux-x64"
  check "ccq.corrupt-gzip.warning" out_has '正在改用 raw 资产'
  check "ccq.corrupt-gzip.bytes" [ "$(cat "$(ccq_target)")" = "$(cat "${WORK}/ccq-raw")" ]
  check "ccq.corrupt-gzip.no-temps" no_transfer_temps
else
  skip "ccq gzip 用例（宿主无 gzip）"
fi

serve_ccq x64 - -
mkdir -p "${WORK}/run-ccq-double-fail/home/.local/bin"
cp "${WORK}/ccq-old" "${WORK}/run-ccq-double-fail/home/.local/bin/ccq"
chmod +x "${WORK}/run-ccq-double-fail/home/.local/bin/ccq"
ANSWERS="1\n" run_entry "ccq-double-fail" Download-Tui.sh CCQ_RELEASE_TAG=v2.0.0
check "ccq.double-fail.rc" [ "${RUN_RC}" -ne 0 ]
check "ccq.double-fail.preserved" [ "$(cat "$(ccq_target)")" = "$(cat "${WORK}/ccq-old")" ]
check "ccq.double-fail.no-temps" no_transfer_temps

serve_ccq x64 "${WORK}/ccq-raw.gz" "${WORK}/ccq-raw"
for scenario in same keep overwrite unknown; do
  mkdir -p "${WORK}/run-ccq-${scenario}/home/.local/bin"
  case "${scenario}" in
    same) cp "${WORK}/ccq-raw" "${WORK}/run-ccq-${scenario}/home/.local/bin/ccq" ;;
    *) cp "${WORK}/ccq-old" "${WORK}/run-ccq-${scenario}/home/.local/bin/ccq" ;;
  esac
  chmod +x "${WORK}/run-ccq-${scenario}/home/.local/bin/ccq"
done
ANSWERS="" run_entry "ccq-same" Download-Tui.sh CCQ_RELEASE_TAG=v2.0.0
check "ccq.same-version.skip" out_has '无需覆盖'
check "ccq.same-version.no-download" log_lacks 'curl'
ANSWERS="\n" run_entry "ccq-keep" Download-Tui.sh CCQ_RELEASE_TAG=v2.0.0
check "ccq.mismatch.default-keep" out_has '已保留当前 ccq 版本: 1.0.0'
check "ccq.mismatch.no-download" log_lacks 'curl'
check "ccq.mismatch.preserved" [ "$(cat "$(ccq_target)")" = "$(cat "${WORK}/ccq-old")" ]
if [ "${HAVE_GZIP}" = "1" ]; then
  ANSWERS="1\n" run_entry "ccq-overwrite" Download-Tui.sh CCQ_RELEASE_TAG=v2.0.0
  check "ccq.overwrite.rc" [ "${RUN_RC}" -eq 0 ]
  check "ccq.overwrite.replaced" [ "$(cat "$(ccq_target)")" = "$(cat "${WORK}/ccq-raw")" ]
  check "ccq.overwrite.no-temps" no_transfer_temps
fi
ANSWERS="" run_entry "ccq-unknown" Download-Tui.sh
check "ccq.unknown-target.keep" out_has '无法确定安装器目标版本，已保留现有 ccq'
check "ccq.unknown-target.no-download" log_lacks 'curl'
check "ccq.default-url-latest" [ "$(env -u CCQ_RELEASE_DOWNLOAD_BASE_URL CCQ_RELEASE_TAG=__CCQ_RELEASE_TAG__ bash -c "source '${LINUX_ROOT}/core/Ccq.sh'; ccq_get_release_download_base_url")" = "https://github.com/MrNine-666/claude-code-quickstart/releases/latest/download" ]
check "ccq.tag-url" [ "$(env -u CCQ_RELEASE_DOWNLOAD_BASE_URL CCQ_RELEASE_TAG=v1.2.3 bash -c "source '${LINUX_ROOT}/core/Ccq.sh'; ccq_get_release_download_base_url")" = "https://github.com/MrNine-666/claude-code-quickstart/releases/download/v1.2.3" ]
check "ccq.normalize" [ "$(bash -c "source '${LINUX_ROOT}/core/Ccq.sh'; ccq_normalize_version ' ccq v1.2.3-rc.1 '")" = "1.2.3-rc.1" ]

# ─── 9. Profile 标记块幂等 ───────────────────────────────────────────────────

profile_twice() {
  printf 'export FOO=1\n' >"${HOME}/.bashrc"
  printf '# zsh user config\n' >"${HOME}/.zshrc"
  ccq_profile_ensure_local_bin >/dev/null && ccq_profile_ensure_local_bin >/dev/null || return 1
  [ "$(grep -c '# >>> ccq local-bin >>>' "${HOME}/.bashrc")" -eq 1 ] &&
    [ "$(grep -c '# >>> ccq local-bin >>>' "${HOME}/.zshrc")" -eq 1 ] &&
    grep -qx 'export FOO=1' "${HOME}/.bashrc" && grep -qx '# zsh user config' "${HOME}/.zshrc"
}
check "profile.idempotent" with_core profile_twice
profile_fish() {
  rm -f "${HOME}/.zshrc"
  SHELL=/usr/bin/fish ccq_profile_ensure_local_bin | grep -q 'fish_add_path' && [ ! -e "${HOME}/.zshrc" ] && [ ! -e "${HOME}/.config/fish" ]
}
check "profile.fish-manual-hint" with_core profile_fish
profile_mode_probe="${WORK}/mode-probe"
: >"${profile_mode_probe}" && chmod 600 "${profile_mode_probe}"
if [ "$(stat -c %a "${profile_mode_probe}" 2>/dev/null)" = "600" ]; then
  profile_keeps_mode() {
    printf 'export SECRET=1\n' >"${HOME}/.bashrc" && chmod 600 "${HOME}/.bashrc"
    ccq_profile_ensure_local_bin >/dev/null && [ "$(stat -c %a "${HOME}/.bashrc")" = "600" ]
  }
  check "profile.keeps-mode" with_core profile_keeps_mode
else
  skip "profile.keeps-mode（宿主文件系统不支持 POSIX 权限）"
fi

# ─── 10. 构建产物分派（可选 --dist）─────────────────────────────────────────

if [ -z "${DIST_DIR}" ]; then
  skip "dist（未传入 --dist）"
else
  for artifact in install.sh download-tui.sh; do
    built="${DIST_DIR}/${artifact}"
    if [ ! -f "${built}" ]; then
      skip "dist.${artifact}（文件不存在）"
      continue
    fi
    temps_clean() { [ -z "$(ls -A "${RUN_DIR}/tmp")" ]; }
    ANSWERS="" run_entry "dist-${artifact}-help" "${built}" -- --help
    check "dist.${artifact}.help" [ "${RUN_RC}" -eq 0 ]
    check "dist.${artifact}.help.temps-clean" temps_clean
    if [ "${artifact}" = "install.sh" ]; then
      ANSWERS="" run_entry "dist-list" "${built}" -- --list-steps
      check "dist.install.list-steps" grep -q '已注册的安装步骤' "${RUN_OUT}"
      check "dist.install.list-steps.temps-clean" temps_clean
      RUN_DIR="${WORK}/run-dist-pipe"; mkdir -p "${RUN_DIR}/tmp"
      env -i HOME="${RUN_DIR}" TMPDIR="${RUN_DIR}/tmp" PATH="$(base_path)" bash -s -- --list-steps <"${built}" >"${RUN_DIR}/out" 2>&1
      check "dist.install.pipe-list-steps" grep -q '已注册的安装步骤' "${RUN_DIR}/out"
      check "dist.install.pipe.temps-clean" temps_clean
      if command -v sh >/dev/null 2>&1; then
        env -i HOME="${RUN_DIR}" TMPDIR="${RUN_DIR}/tmp" PATH="$(base_path)" "$(command -v sh)" "${built}" --help >"${RUN_DIR}/out" 2>&1
        check "dist.install.sh-help" [ "$?" -eq 0 ]
        check "dist.install.sh-help.temps-clean" temps_clean
      fi
    fi
    ANSWERS="" run_entry "dist-${artifact}-unknown-os" "${built}" FAKE_UNAME_S=FreeBSD -- --help
    check "dist.${artifact}.unknown-os.rejected" [ "${RUN_RC}" -ne 0 ]
    check "dist.${artifact}.unknown-os.temps-clean" temps_clean
    ANSWERS="" run_entry "dist-${artifact}-musl" "${built}" FAKE_LIBC=musl
    check "dist.${artifact}.musl.rejected" [ "${RUN_RC}" -ne 0 ]
    check "dist.${artifact}.musl.no-download" log_lacks 'curl'
    check "dist.${artifact}.musl.temps-clean" temps_clean
    ANSWERS="" run_entry "dist-${artifact}-wsl1" "${built}" CCQ_PROC_VERSION_FILE="${WORK}/proc-wsl1"
    check "dist.${artifact}.wsl1.rejected" [ "${RUN_RC}" -ne 0 ]
    check "dist.${artifact}.wsl1.temps-clean" temps_clean
  done
fi

summary_and_exit
