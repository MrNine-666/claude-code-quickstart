#!/usr/bin/env zsh
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
