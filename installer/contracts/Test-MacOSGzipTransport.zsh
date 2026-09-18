#!/usr/bin/env zsh

set -eu

script_dir="$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)"
# CCQ 行为函数已迁入 core/Ccq.zsh；probe 直接 source 共享实现。
source "${script_dir}/../macos/core/Ccq.zsh"

probe_root="$(mktemp -d "${TMPDIR:-/tmp}/ccq-gzip-contract.XXXXXX")" || exit 1
cleanup() {
  rm -rf "${probe_root}"
}
trap cleanup EXIT INT TERM

raw_fixture="${probe_root}/raw-fixture"
gzip_fixture="${probe_root}/raw-fixture.gz"
empty_fixture="${probe_root}/empty-fixture"
empty_gzip_fixture="${probe_root}/empty-fixture.gz"
corrupt_fixture="${probe_root}/corrupt.gz"
call_log="${probe_root}/calls.log"
warning_log="${probe_root}/warnings.log"
error_log="${probe_root}/errors.log"
target_path="${probe_root}/bin/ccq"
raw_url="https://example.invalid/ccq-macos-arm64"

mkdir -p "${probe_root}/bin" "${probe_root}/home"
export HOME="${probe_root}/home"
export PATH="${probe_root}/bin:${PATH}"
printf 'ccq gzip transport fixture\nline two\n' > "${raw_fixture}"
: > "${empty_fixture}"
gzip -c "${raw_fixture}" > "${gzip_fixture}"
gzip -c "${empty_fixture}" > "${empty_gzip_fixture}"
gzip_size="$(wc -c < "${gzip_fixture}" | tr -d '[:space:]')"
truncated_size=$((gzip_size - 4))
[ "${truncated_size}" -gt 0 ] || { printf '[FAIL] gzip fixture 太短，无法构造尾部损坏探针\n' >&2; exit 1; }
dd if="${gzip_fixture}" of="${corrupt_fixture}" bs=1 count="${truncated_size}" 2>/dev/null

fail() {
  printf '[FAIL] macOS gzip transport: %s\n' "$1" >&2
  exit 1
}

assert_calls() {
  local expected_count="$1"
  local actual_count
  actual_count="$(wc -l < "${call_log}" | tr -d '[:space:]')"
  [ "${actual_count}" = "${expected_count}" ] || fail "调用次数应为 ${expected_count}，实际 ${actual_count}"
  [ "$(sed -n '1p' "${call_log}")" = "${raw_url}.gz|${target_path}.download.$$.gz" ] || fail '第一次传输不是 gzip URL/独立 gzip temp'
  if [ "${expected_count}" -eq 2 ]; then
    [ "$(sed -n '2p' "${call_log}")" = "${raw_url}|${target_path}.download.$$" ] || fail 'raw fallback 没有作为独立传输重新开始'
  fi
}

assert_no_transport_temps() {
  [ ! -e "${target_path}.download.$$" ] || fail '残留 raw temp'
  [ ! -e "${target_path}.download.$$.gz" ] || fail '残留 gzip temp'
}

ccq_get_executable_path() {
  printf '%s' "${target_path}"
}

ccq_ui_info() { :; }
ccq_ui_dim() { :; }
ccq_ui_success() { :; }
ccq_ui_warning() {
  printf '%s\n' "$1" >> "${warning_log}"
}

typeset -g CCQ_GZIP_PROBE_SCENARIO=""

ccq_download_file() {
  local url="$1" output_path="$2"
  printf '%s|%s\n' "${url}" "${output_path}" >> "${call_log}"
  rm -f "${output_path}" 2>/dev/null || true
  CCQ_DOWNLOAD_ERROR=""

  case "${CCQ_GZIP_PROBE_SCENARIO}:${url}" in
    gzip-success:*.gz)
      cp "${gzip_fixture}" "${output_path}"
      ;;
    gzip-download-fail:*.gz)
      printf 'partial-gzip' > "${output_path}"
      CCQ_DOWNLOAD_ERROR="fixture gzip download failed"
      return 1
      ;;
    gzip-corrupt:*.gz)
      cp "${corrupt_fixture}" "${output_path}"
      ;;
    gzip-empty:*.gz)
      cp "${empty_gzip_fixture}" "${output_path}"
      ;;
    double-fail:*.gz)
      printf 'partial-gzip' > "${output_path}"
      CCQ_DOWNLOAD_ERROR="fixture gzip download failed"
      return 1
      ;;
    double-fail-corrupt:*.gz)
      cp "${corrupt_fixture}" "${output_path}"
      ;;
    gzip-success:*)
      CCQ_DOWNLOAD_ERROR="raw must not be requested after gzip success"
      return 1
      ;;
    double-fail:*|double-fail-corrupt:*)
      printf 'partial-raw' > "${output_path}"
      CCQ_DOWNLOAD_ERROR="fixture raw download failed"
      return 1
      ;;
    *)
      cp "${raw_fixture}" "${output_path}"
      ;;
  esac
  return 0
}

run_success_case() {
  local scenario="$1" expected_calls="$2" expect_warning="$3"
  CCQ_GZIP_PROBE_SCENARIO="${scenario}"
  : > "${call_log}"
  : > "${warning_log}"
  printf 'OLD-TARGET' > "${target_path}"

  ccq_install_executable "${raw_url}" > /dev/null 2> "${error_log}" || fail "${scenario} 应安装成功"
  cmp -s "${raw_fixture}" "${target_path}" || fail "${scenario} 最终字节与 raw fixture 不一致"
  assert_calls "${expected_calls}"
  assert_no_transport_temps
  if [ "${expect_warning}" -eq 1 ]; then
    grep -q '正在改用 raw 资产' "${warning_log}" || fail "${scenario} 缺少 raw fallback 提示"
  elif [ -s "${warning_log}" ]; then
    fail "${scenario} 不应显示 fallback 提示"
  fi
}

run_success_case gzip-success 1 0
run_success_case gzip-download-fail 2 1
run_success_case gzip-corrupt 2 1
run_success_case gzip-empty 2 1

run_failure_case() {
  local scenario="$1" expected_gzip_context="$2"
  CCQ_GZIP_PROBE_SCENARIO="${scenario}"
  : > "${call_log}"
  : > "${warning_log}"
  printf 'MUST-SURVIVE' > "${target_path}"
  cp "${target_path}" "${probe_root}/expected-old-target"
  if ccq_install_executable "${raw_url}" > /dev/null 2> "${error_log}"; then
    fail "${scenario} gzip/raw 双失败应返回失败"
  fi
  cmp -s "${probe_root}/expected-old-target" "${target_path}" || fail "${scenario} 双失败修改了已有 target"
  assert_calls 2
  assert_no_transport_temps
  grep -q 'raw 下载失败: fixture raw download failed' "${error_log}" || fail "${scenario} 错误没有以 raw 失败为主"
  grep -q "gzip 失败上下文: ${expected_gzip_context}" "${error_log}" || fail "${scenario} 错误缺少 gzip 上下文"
  grep -q '正在改用 raw 资产' "${warning_log}" || fail "${scenario} 双失败前缺少 raw fallback 提示"
}

run_failure_case double-fail 'gzip 下载失败: fixture gzip download failed'
run_failure_case double-fail-corrupt 'gzip 解压失败或数据损坏'

# ── 专用入口（dedicated）资产选择与错误平台/未知架构失败 ─────────────────────
# 覆盖 macOS 专用入口：只允许 Darwin x64/arm64，资产名必须由架构决定，绝不回退猜测。
CCQ_PROBE_KERNEL="Darwin"
CCQ_PROBE_ARCH="arm64"
uname() {
  case "${1:-}" in
    -s) printf '%s' "${CCQ_PROBE_KERNEL}" ;;
    -m) printf '%s' "${CCQ_PROBE_ARCH}" ;;
    *) command uname "$@" ;;
  esac
}

CCQ_DEDICATED_URLS=()
# 安装结果可控：专用入口的退出码必须忠实反映它，而不是永远返回成功。
CCQ_PROBE_INSTALL_RESULT=0
ccq_install_executable() {
  CCQ_DEDICATED_URLS+=("$1")
  return "${CCQ_PROBE_INSTALL_RESULT}"
}
ccq_ui_primary() { :; }
ccq_ui_danger() { :; }
ccq_show_single_select_menu() { printf '0'; }
ccq_test_executable_installed() {
  printf '{"isInstalled":0,"version":"","path":"%s"}\n' "${target_path}"
}

assert_dedicated_asset() {
  local probe_arch="$1" expected_suffix="$2"
  CCQ_PROBE_KERNEL="Darwin"
  CCQ_PROBE_ARCH="${probe_arch}"
  CCQ_DEDICATED_URLS=()
  ccq_confirm_executable_download dedicated > /dev/null 2>&1 || fail "dedicated ${probe_arch} handoff 应成功"
  [ "${#CCQ_DEDICATED_URLS[@]}" -eq 1 ] || fail "dedicated ${probe_arch} 应恰好调用一次安装"
  case "${CCQ_DEDICATED_URLS[1]}" in
    *"${expected_suffix}") ;;
    *) fail "dedicated ${probe_arch} 资产选择错误: ${CCQ_DEDICATED_URLS[1]}" ;;
  esac
}

assert_dedicated_asset arm64 'ccq-macos-arm64'
assert_dedicated_asset x86_64 'ccq-macos-x64'

# 安装失败的返回值必须向上传播：专用入口的退出码就是脚本退出码，
# 否则 curl | zsh 与 CI 会把「下载失败」当作成功。
CCQ_PROBE_KERNEL="Darwin"
CCQ_PROBE_ARCH="arm64"
CCQ_DEDICATED_URLS=()
CCQ_PROBE_INSTALL_RESULT=1
if ccq_confirm_executable_download dedicated > /dev/null 2>&1; then
  fail 'dedicated handoff 在安装失败时必须返回非零'
fi
[ "${#CCQ_DEDICATED_URLS[@]}" -eq 1 ] || fail 'dedicated 安装失败场景应恰好尝试一次安装'
CCQ_PROBE_INSTALL_RESULT=0

# 非 Darwin 平台必须明确失败，不得选择 macos 资产。
CCQ_PROBE_KERNEL="Linux"
CCQ_PROBE_ARCH="x86_64"
CCQ_DEDICATED_URLS=()
if ccq_confirm_executable_download dedicated > /dev/null 2>&1; then
  fail '非 Darwin 平台运行 dedicated handoff 应失败'
fi
[ "${#CCQ_DEDICATED_URLS[@]}" -eq 0 ] || fail '非 Darwin 平台不得下载任何资产'

# 未知架构必须明确失败，不得回退猜测。
CCQ_PROBE_KERNEL="Darwin"
CCQ_PROBE_ARCH="riscv64"
if ccq_get_architecture > /dev/null 2>&1; then
  fail '未知架构 ccq_get_architecture 应失败'
fi

printf '%s\n' '[PASS] macOS gzip transport behavior probe passed'
