#!/usr/bin/env zsh
# Skills.zsh - macOS Skills 安装步骤
# 功能: source 单选、集合子 Skills 多选、copy 模式和官方 skills update

if [ -n "${CCQ_STEP_SKILLS_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_STEP_SKILLS_ZSH_LOADED=1

ccq_source_npm_common() {
  if command -v ccq_npm_tool_require_npx >/dev/null 2>&1; then return 0; fi
  local common_path="${CCQ_INSTALLER_ROOT:-$(cd "${0:A:h}/../.." && pwd)}/macos/steps/_NpmToolCommon.zsh"
  [ -f "${common_path}" ] && source "${common_path}"
}
ccq_source_npm_common

ccq_skills_contract_path() {
  if [ -n "${CCQ_SKILLS_CONTRACT:-}" ] && [ -f "${CCQ_SKILLS_CONTRACT}" ]; then
    printf '%s\n' "${CCQ_SKILLS_CONTRACT}"
    return 0
  fi
  local source_path="${CCQ_INSTALLER_ROOT:-$(cd "${0:A:h}/../.." && pwd)}/contracts/skills.json"
  [ -f "${source_path}" ] && { printf '%s\n' "${source_path}"; return 0; }
  return 1
}

ccq_ui_contract_path() {
  if [ -n "${CCQ_UI_CONTRACT:-}" ] && [ -f "${CCQ_UI_CONTRACT}" ]; then
    printf '%s\n' "${CCQ_UI_CONTRACT}"
    return 0
  fi
  local source_path="${CCQ_INSTALLER_ROOT:-$(cd "${0:A:h}/../.." && pwd)}/contracts/ui.json"
  [ -f "${source_path}" ] && { printf '%s\n' "${source_path}"; return 0; }
  return 1
}

ccq_skills_catalogue_fallback() {
  cat <<'EOF'
find-skills	find-skills	vercel-labs/skills	find-skills	Skills 发现辅助技能	true		false	10
anthropics-skills	官方 Skills	anthropics/skills		Anthropic 官方 Skills 集合	false		false	20
vercel-agent-skills	Vercel Agent Skills	vercel-labs/agent-skills		Vercel Agent Skills 集合	false		false	30
vue-skills	Vue Skills	vuejs-ai/skills		Vue 开发 Skills 集合	false		false	40
ui-ux-pro-max	UI UX Pro Max	nextlevelbuilder/ui-ux-pro-max-skill		UI/UX 设计与前端体验技能	false		false	50
shadcn-ui-skills	shadcn/ui Skills	shadcn/ui		shadcn/ui 组件开发 Skills 集合	false		false	60
wot-ui-skills	Wot UI Skills	wot-ui/open-wot		Wot UI 开发 Skills 集合	false		false	70
ant-design-skills	Ant Design Skills	ant-design/ant-design-cli		Ant Design 开发 Skills 集合	false		false	80
ant-design-x-skills	Ant Design X Skills	https://github.com/ant-design/x/tree/main/packages/x-skill		Ant Design X Skills 集合	false		false	90
fastapi-skills	FastAPI Skills	https://github.com/fastapi/fastapi	fastapi	FastAPI 开发 Skills	false		false	100
langchain-skills	LangChain Skills	langchain-ai/langchain-skills		LangChain 开发 Skills 集合	false		false	110
ppt-master	PPT Master	hugohe3/ppt-master		PPT 生成与演示文稿技能	false	ppt-master	true	120
EOF
}

ccq_skills_ignored_names_fallback() {
  cat <<'EOF'
ccg-skills
collaborating-with-codex
collaborating-with-gemini
EOF
}

ccq_skills_catalogue() {
  local contract_path
  contract_path="$(ccq_skills_contract_path 2>/dev/null || true)"
  if [ -n "${contract_path}" ] && command -v node >/dev/null 2>&1; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const rows = [...(contract.Catalogue || [])].sort((a, b) => Number(a.Order || 9999) - Number(b.Order || 9999));
for (const item of rows) {
  console.log([
    item.Id || "",
    item.Name || "",
    item.Source || "",
    item.SkillName || "",
    item.Description || "",
    item.Default === true ? "true" : "false",
    item.StaticSkillName || "",
    item.SkipDiscovery === true ? "true" : "false",
    String(item.Order || 9999)
  ].join("\t"));
}
' "${contract_path}" && return 0
  fi
  ccq_skills_catalogue_fallback
}

ccq_skills_ignored_names() {
  local contract_path
  contract_path="$(ccq_skills_contract_path 2>/dev/null || true)"
  if [ -n "${contract_path}" ] && command -v node >/dev/null 2>&1; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const names = (contract.IgnoredSkillNames || [])
  .map(name => String(name || "").trim())
  .filter(Boolean);
if (names.length === 0) process.exit(1);
for (const name of names) console.log(name);
' "${contract_path}" 2>/dev/null && return 0
  fi
  ccq_skills_ignored_names_fallback
}

ccq_ui_contract_value() {
  local expression="${1:-}"
  local fallback="${2:-}"
  local contract_path
  contract_path="$(ccq_ui_contract_path 2>/dev/null || true)"
  if [ -n "${contract_path}" ] && command -v node >/dev/null 2>&1; then
    node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const path = process.argv[2].split(".").filter(Boolean);
let value = contract;
for (const key of path) {
  if (value == null || !Object.prototype.hasOwnProperty.call(value, key)) process.exit(1);
  value = value[key];
}
if (Array.isArray(value)) process.stdout.write(value.join("\n"));
else process.stdout.write(String(value));
' "${contract_path}" "${expression}" && return 0
  fi
  printf '%s' "${fallback}"
}

ccq_skills_tty() { [ -r /dev/tty ] && [ -w /dev/tty ]; }

ccq_join_by_comma() {
  local first=1 item
  for item in "$@"; do
    if [ "${first}" = "1" ]; then
      printf '%s' "${item}"
      first=0
    else
      printf ',%s' "${item}"
    fi
  done
}

ccq_skills_result() {
  printf 'IsInstalled=%s\n' "${1:-false}"
  printf 'Version=%s\n' "${2:-}"
  printf 'Message=%s\n' "${3:-}"
}

ccq_skills_install_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'Installed=%s\n' "${2:-}"
  printf 'ErrorMessage=%s\n' "${3:-}"
}

ccq_skills_installed_json() {
  ccq_npm_tool_require_npx || return 1
  npx --yes skills list -g -a claude-code --json 2>/dev/null || printf '[]\n'
}

ccq_skills_installed_names() {
  local ignored
  ignored="$(ccq_skills_ignored_names 2>/dev/null || true)"
  ccq_skills_installed_json | CCQ_SKILLS_IGNORED_NAMES="${ignored}" node -e '
const fs = require("fs");
const raw = fs.readFileSync(0, "utf8").trim() || "[]";
const ignored = new Set(String(process.env.CCQ_SKILLS_IGNORED_NAMES || "")
  .split(/\r?\n/)
  .map(name => name.trim().toLowerCase())
  .filter(Boolean));
let items = [];
try { items = JSON.parse(raw); } catch { items = []; }
for (const item of items) {
  if (!item || !item.name) continue;
  const name = String(item.name).trim();
  if (!name || ignored.has(name.toLowerCase())) continue;
  console.log(name);
}
' 2>/dev/null || true
}

ccq_skills_known_static_names() {
  local line id name source skill desc default static_name skip_discovery order
  while IFS=$'\t' read -r id name source skill desc default static_name skip_discovery order; do
    if [ -n "${static_name}" ]; then
      printf '%s\n' "${static_name}"
    elif [ -n "${skill}" ]; then
      printf '%s\n' "${skill}"
    fi
  done <<EOF
$(ccq_skills_catalogue)
EOF
}

ccq_skills_any_known_installed() {
  local installed known name
  installed="$(ccq_skills_installed_names)"
  known="$(ccq_skills_known_static_names)"
  for name in ${known}; do
    printf '%s\n' "${installed}" | grep -qi "^${name}$" && return 0
  done
  [ -n "${installed}" ]
}

ccq_skills_discovery_script_path() {
  printf '%s\n' "${CCQ_CONTRACTS_DIR:-${CCQ_INSTALLER_ROOT}/contracts}/scripts/skills-discovery.js"
}

ccq_skills_source_list() {
  local source="${1:-}"
  local skill="${2:-}"
  local args=(--yes skills add "${source}" --list -g --agent claude-code)
  local script_path
  [ -n "${skill}" ] && args+=(--skill "${skill}")
  ccq_npm_tool_require_npx || return 1

  script_path="$(ccq_skills_discovery_script_path)"
  if [ -f "${script_path}" ]; then
    # 优先使用共享 js 脚本
    npx "${args[@]}" 2>&1 | node "${script_path}" --mode parse --input - 2>/dev/null | node -e 'const v=JSON.parse(require("fs").readFileSync(0,"utf8")); (v.names||[]).forEach(n=>console.log(n));' || true
  else
    # Fallback: 内嵌实现
    npx "${args[@]}" 2>/dev/null | node -e '
const fs = require("fs");
const text = fs.readFileSync(0, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
const names = new Set();
for (const raw of text.split(/\r?\n/)) {
  const line = raw.trim().replace(/^│/, "").trim();
  if (/^[A-Za-z0-9][A-Za-z0-9:_-]{0,79}$/.test(line)) names.add(line);
}
for (const name of names) console.log(name);
' || true
  fi
}

# ─── 预取并发（macOS zsh 后台 job 实现，对齐 Windows ThreadJob）─────────────
ccq_skills_discovery_cache_dir() {
  printf '%s/.ccq/skills-discovery-cache\n' "${TMPDIR:-/tmp}"
}

ccq_skills_prefetch_one() {
  local source="${1:-}"
  local skill="${2:-}"
  local cache_file="${3:-}"
  local names
  names="$(ccq_skills_source_list "${source}" "${skill}" 2>/dev/null || true)"
  if [ -n "${names}" ]; then
    printf '%s\n' "${names}" > "${cache_file}" 2>/dev/null || true
  else
    printf '' > "${cache_file}" 2>/dev/null || true
  fi
}

ccq_skills_prefetch_all() {
  local cache_dir max_concurrent=2 jobs=0 record id name source skill skip_discovery cache_file pid
  cache_dir="$(ccq_skills_discovery_cache_dir)"
  mkdir -p "${cache_dir}" 2>/dev/null || return 0

  while IFS=$'\t' read -r id name source skill desc default static_name skip_discovery order; do
    [ "${skip_discovery}" = "true" ] && continue
    [ -z "${source}" ] && continue
    cache_file="${cache_dir}/${id}.txt"
    [ -f "${cache_file}" ] && continue

    while [ "${jobs}" -ge "${max_concurrent}" ]; do
      wait -n 2>/dev/null || sleep 0.1
      jobs=$((jobs - 1))
    done

    ccq_skills_prefetch_one "${source}" "${skill}" "${cache_file}" &
    jobs=$((jobs + 1))
  done <<EOF
$(ccq_skills_catalogue)
EOF

  wait 2>/dev/null || true
}

ccq_skills_source_list_cached() {
  local id="${1:-}"
  local source="${2:-}"
  local skill="${3:-}"
  local cache_dir cache_file
  cache_dir="$(ccq_skills_discovery_cache_dir)"
  cache_file="${cache_dir}/${id}.txt"
  if [ -f "${cache_file}" ]; then
    cat "${cache_file}" 2>/dev/null || ccq_skills_source_list "${source}" "${skill}"
  else
    ccq_skills_source_list "${source}" "${skill}"
  fi
}

ccq_skills_select_source() {
  ccq_skills_tty || return 1
  local lines id name source skill desc default static_name skip_discovery order options=() records=() defaults=() index=0
  lines="$(ccq_skills_catalogue)"
  while IFS=$'\t' read -r id name source skill desc default static_name skip_discovery order; do
    [ -n "${id}" ] || continue
    options+=("${name} - ${desc}")
    records+=("${id}	${name}	${source}	${skill}	${desc}	${default}	${static_name}	${skip_discovery}	${order}")
    if [ "${default}" = "true" ]; then
      defaults+=("${index}")
    fi
    index=$((index + 1))
  done <<EOF
${lines}
EOF
  [ "${#options[@]}" -gt 0 ] || return 1

  # 多选 Skills source
  local selected_indices
  selected_indices="$(ccq_show_multi_select_menu "Skills - 选择要安装的 Skills（支持多选）" "${defaults[*]}" "${options[@]}")" || return 1
  [ -n "${selected_indices}" ] || return 1

  # 输出选中的所有 records（每行一条）
  for selected_index in ${selected_indices}; do
    printf '%s\n' "${records[$(((selected_index + 1) > ${#records[@]} ? ${#records[@]} : selected_index + 1))]}"
  done
}

ccq_skills_select_children() {
  local id="${1:-}"
  local source="${2:-}"
  local skill="${3:-}"
  local skip_discovery="${4:-false}"
  local static_name="${5:-}"
  local names item selected_indices selected_index defaults=() i=0

  # SkipDiscovery 静态名检测：优先使用 static_name，回退到 skill
  if [ "${skip_discovery}" = "true" ]; then
    if [ -n "${static_name}" ]; then
      printf '%s\n' "${static_name}"
    elif [ -n "${skill}" ]; then
      printf '%s\n' "${skill}"
    fi
    return 0
  fi

  names="$(ccq_skills_source_list_cached "${id}" "${source}" "${skill}")"
  [ -n "${names}" ] || return 0
  local options=(${names})
  [ "${#options[@]}" -gt 1 ] || { printf '%s\n' "${options[@]}"; return 0; }
  ccq_skills_tty || { printf '%s\n' "${options[@]}"; return 0; }

  while [ "${i}" -lt "${#options[@]}" ]; do
    defaults+=("${i}")
    i=$((i + 1))
  done
  selected_indices="$(ccq_show_multi_select_menu "Skills - 选择要安装的子 Skills" "${defaults[*]}" "${options[@]}")" || return 1
  [ -n "${selected_indices}" ] || return 1
  for selected_index in ${selected_indices}; do
    printf '%s\n' "${options[$(((selected_index + 1) > ${#options[@]} ? ${#options[@]} : selected_index + 1))]}"
  done
}

ccq_skills_resolve_copy_mode() {
  ccq_skills_tty || { printf '0\n'; return 0; }
  local title option_text choice options=()
  title="$(ccq_ui_contract_value Menus.Skills.CopyModeTitle '是否启用 Skills copy 模式？')"
  option_text="$(ccq_ui_contract_value Menus.Skills.CopyModeOptions '')"
  if [ -n "${option_text}" ]; then
    while IFS= read -r line; do
      [ -n "${line}" ] && options+=("${line}")
    done <<EOF
${option_text}
EOF
  fi
  if [ "${#options[@]}" -lt 2 ]; then
    options=("不启用 copy 模式（默认）" "启用 copy 模式（追加 --copy，适合 symlink 权限受限）")
  fi
  choice="$(ccq_show_single_select_menu "${title}" 0 "${options[@]}")" || { printf '0\n'; return 0; }
  if [ "${choice}" = "1" ]; then
    printf '1\n'
  else
    printf '0\n'
  fi
}

ccq_skills_install_one() {
  local source="${1:-}"
  local skill="${2:-}"
  local copy_mode="${3:-0}"
  local args=(--yes skills add "${source}" --yes --agent claude-code -g)
  [ -n "${skill}" ] && args+=(--skill "${skill}")
  [ "${copy_mode}" = "1" ] && args+=(--copy)
  ccq_run_command --timeout 300 --retries 1 -- npx "${args[@]}"
}

Test-SkillsInstalled() {
  ccq_source_npm_common
  if ccq_skills_any_known_installed; then
    ccq_skills_result true "" "已检测到 Claude Code 全局 Skills"
  else
    ccq_skills_result false "" "未检测到已知 Skills"
  fi
}

# ─── 安装摘要（成功/已存在/失败/跳过 四分类，对齐 Windows）─────────────────

ccq_skills_show_install_summary() {
  local installed_csv="${1:-}"
  local existing_csv="${2:-}"
  local failed_csv="${3:-}"
  local skipped_csv="${4:-}"
  printf '\n'
  ccq_ui_primary "Skills 安装摘要："
  [ -n "${installed_csv}" ] && ccq_ui_success "  新安装: ${installed_csv}"
  [ -n "${existing_csv}" ] && ccq_ui_dim "  已存在(重装): ${existing_csv}"
  [ -n "${failed_csv}" ] && ccq_ui_danger "  失败: ${failed_csv}"
  [ -n "${skipped_csv}" ] && ccq_ui_warning "  跳过: ${skipped_csv}"
  if [ -z "${installed_csv}${existing_csv}${failed_csv}${skipped_csv}" ]; then
    ccq_ui_dim "  本次无 Skills 变更"
  fi
}

Install-Skills() {
  ccq_source_npm_common
  if ! ccq_npm_tool_require_npx; then
    ccq_skills_install_result false "" "${CCQ_NPM_TOOL_ERROR:-npx 不可用}"
    return 1
  fi
  if ! ccq_command_exists claude; then
    ccq_skills_install_result false "" "Claude Code 不可用，请先完成 ClaudeCode 步骤"
    return 1
  fi

  ccq_skills_prefetch_all &

  local selected_records copy_mode installed=() existing=() failures=() pre_installed
  copy_mode="$(ccq_skills_resolve_copy_mode)"

  # 多选 source，返回多行 record
  selected_records="$(ccq_skills_select_source)" || {
    ccq_skills_install_result false "" "用户取消 Skills source 选择"
    return 1
  }

  [ -n "${selected_records}" ] || {
    ccq_skills_install_result false "" "未选择任何 Skills"
    return 1
  }

  # 安装前快照已安装名单
  pre_installed="$(ccq_skills_installed_names 2>/dev/null || true)"

  # 循环处理每个 selected record
  while IFS=$'\t' read -r id name source skill desc default static_name skip_discovery order; do
    [ -n "${id}" ] || continue

    local selected_names child
    if ! selected_names="$(ccq_skills_select_children "${id}" "${source}" "${skill}" "${skip_discovery}" "${static_name}")"; then
      ccq_ui_warning "跳过 ${id}：用户取消子 Skills 选择" "developer"
      continue
    fi

    if [ -z "${selected_names}" ] && [ -n "${skill}" ]; then
      selected_names="${skill}"
    fi

    if [ -z "${selected_names}" ]; then
      if ccq_skills_install_one "${source}" "" "${copy_mode}"; then
        installed+=("${id}")
      else
        failures+=("${id}")
        ccq_ui_warning "Skill 安装失败: ${id}，继续处理剩余项" "developer"
      fi
    else
      for child in ${selected_names}; do
        if ccq_skills_install_one "${source}" "${child}" "${copy_mode}"; then
          if printf '%s\n' "${pre_installed}" | grep -qi "^${child}$"; then
            existing+=("${child}")
          else
            installed+=("${child}")
          fi
        else
          failures+=("${child}")
          ccq_ui_warning "Skill 安装失败: ${child}，继续处理剩余项" "developer"
        fi
      done
    fi
  done <<EOF
${selected_records}
EOF

  ccq_skills_show_install_summary \
    "$(ccq_join_by_comma "${installed[@]}")" \
    "$(ccq_join_by_comma "${existing[@]}")" \
    "$(ccq_join_by_comma "${failures[@]}")" \
    ""

  if [ "${#failures[@]}" -gt 0 ]; then
    ccq_skills_install_result false "$(ccq_join_by_comma "${installed[@]}" "${existing[@]}")" "安装失败: $(ccq_join_by_comma "${failures[@]}")"
    return 1
  fi
  ccq_skills_install_result true "$(ccq_join_by_comma "${installed[@]}" "${existing[@]}")" ""
}

Verify-Skills() {
  if ccq_skills_any_known_installed; then
    printf 'Success=true\nErrorMessage=\n'
    return 0
  fi
  printf 'Success=false\nErrorMessage=Skills 验证失败\n'
  return 1
}

# 根据 skills update 输出判断是否无可更新项（对齐 Windows Test-SkillsUpdateOutputNoChange）
ccq_skills_update_output_is_noop() {
  local text="${1:-}"
  [ -n "${text}" ] || return 1
  printf '%s' "${text}" | node -e '
const text = require("fs").readFileSync(0, "utf8").replace(/\x1B\[[0-?]*[ -/]*[@-~]/g, "");
process.exit(/no\s+updates|already\s+up\s+to\s+date|up\s+to\s+date|all\s+skills\s+.*latest|0\s+skills?\s+updated/i.test(text) ? 0 : 1);
' 2>/dev/null
}

Update-Skills() {
  ccq_source_npm_common
  if ! ccq_npm_tool_require_npx; then
    ccq_step_update_result false "" "" "${CCQ_NPM_TOOL_ERROR:-npx 不可用}"
    return 1
  fi

  # 无已安装 Skills → noop 短路，不执行远程 update
  local before_names
  before_names="$(ccq_skills_installed_names 2>/dev/null || true)"
  if [ -z "${before_names}" ]; then
    ccq_step_update_result true "noop::Skills::no-installed-skills" "" ""
    return 0
  fi

  if ccq_run_command_developer_or_silent --timeout 600 --retries 1 -- npx --yes skills update -g -y; then
    if ccq_skills_update_output_is_noop "${CCQ_LAST_OUTPUT}${CCQ_LAST_ERROR}"; then
      ccq_step_update_result true "noop::Skills::no-change" "" ""
    else
      ccq_step_update_result true "skills::global::updated" "" ""
    fi
    return 0
  fi
  ccq_step_update_result false "" "" "Skills 官方 update 失败"
  return 1
}

ccq_skills_remove_result() {
  printf 'Success=%s\n' "${1:-false}"
  printf 'Removed=%s\n' "${2:-}"
  printf 'ErrorMessage=%s\n' "${3:-}"
}

ccq_skills_select_installed_names() {
  local names name options=() selected_indices selected_index
  names="$(ccq_skills_installed_names)"
  [ -n "${names}" ] || return 1
  for name in ${names}; do
    options+=("${name}")
  done

  if [ "${#options[@]}" -eq 1 ]; then
    printf '%s\n' "${options[1]}"
    return 0
  fi

  ccq_skills_tty || { printf '%s\n' "${options[@]}"; return 0; }
  selected_indices="$(ccq_show_multi_select_menu "Skills - 选择要卸载的 Skills" "" "${options[@]}")" || return 1
  [ -n "${selected_indices}" ] || return 1
  for selected_index in ${selected_indices}; do
    printf '%s\n' "${options[$(((selected_index + 1) > ${#options[@]} ? ${#options[@]} : selected_index + 1))]}"
  done
}

Uninstall-Skills() {
  ccq_source_npm_common
  if ! ccq_npm_tool_require_npx; then
    ccq_skills_remove_result false "" "${CCQ_NPM_TOOL_ERROR:-npx 不可用}"
    return 1
  fi

  local selected names_arg=() name removed=() failed=() confirm
  selected="$(ccq_skills_select_installed_names)" || {
    ccq_skills_remove_result true "" ""
    return 0
  }
  for name in ${selected}; do
    names_arg+=("${name}")
  done

  if ccq_skills_tty; then
    confirm="$(ccq_show_single_select_menu "确认卸载这些 Skills：$(ccq_join_by_comma "${names_arg[@]}") ?" 1 "是，卸载" "否，取消")" || confirm="1"
    [ "${confirm}" = "0" ] || { ccq_skills_remove_result true "" ""; return 0; }
  fi

  # 逐个卸载：单项失败不中断剩余项（spec: Skills 管理卸载对齐）
  for name in "${names_arg[@]}"; do
    if ccq_run_command --timeout 300 --retries 1 -- npx --yes skills remove "${name}" -g -a claude-code --yes >/dev/null 2>&1; then
      removed+=("${name}")
    else
      failed+=("${name}")
      ccq_ui_warning "Skill 卸载失败: ${name}，继续处理剩余项" "developer"
    fi
  done

  printf '\n'
  ccq_ui_primary "Skills 卸载摘要："
  [ "${#removed[@]}" -gt 0 ] && ccq_ui_success "  已卸载: $(ccq_join_by_comma "${removed[@]}")"
  [ "${#failed[@]}" -gt 0 ] && ccq_ui_danger "  失败: $(ccq_join_by_comma "${failed[@]}")"

  if [ "${#failed[@]}" -gt 0 ]; then
    ccq_skills_remove_result false "$(ccq_join_by_comma "${removed[@]}")" "卸载失败: $(ccq_join_by_comma "${failed[@]}")"
    return 1
  fi
  ccq_skills_remove_result true "$(ccq_join_by_comma "${removed[@]}")" ""
}

ccq_skills_show_status() {
  local installed line id name source skill desc default static_name skip_discovery order
  local check_name extra_names=()
  installed="$(ccq_skills_installed_names)"
  ccq_ui_primary "Skills 状态："
  if [ -z "${installed}" ]; then
    ccq_ui_warning "  尚未检测到 Claude Code 全局 Skills"
    return 0
  fi

  # 按 catalogue 条目展示安装状态（静态名可判定的条目）
  local claimed=" "
  while IFS=$'\t' read -r id name source skill desc default static_name skip_discovery order; do
    [ -n "${id}" ] || continue
    check_name="${static_name:-${skill}}"
    [ -n "${check_name}" ] || continue
    if printf '%s\n' "${installed}" | grep -qi "^${check_name}$"; then
      ccq_ui_success "  [已安装] ${name} - ${check_name}"
      claimed="${claimed}${check_name:l} "
    fi
  done <<EOF
$(ccq_skills_catalogue)
EOF

  # catalogue 之外的已安装 Skills（含集合类 source 安装的子 Skills）
  while IFS= read -r check_name; do
    [ -n "${check_name}" ] || continue
    case "${claimed}" in
      *" ${check_name:l} "*) ;;
      *) extra_names+=("${check_name}") ;;
    esac
  done <<EOF
${installed}
EOF
  if [ "${#extra_names[@]}" -gt 0 ]; then
    ccq_ui_info "  其他已安装 Skills:"
    local extra
    for extra in "${extra_names[@]}"; do
      ccq_ui_info "    - ${extra}"
    done
  fi
}

ccq_skills_manage_menu() {
  local choice
  while true; do
    ccq_skills_show_status
    ccq_skills_tty || return 0
    choice="$(ccq_show_single_select_menu "Skills 管理" 0 \
      "安装 Skills（从 catalogue 选择 source / 子 Skills）" \
      "更新 Skills（官方 skills update）" \
      "卸载 Skills" \
      "返回")" || return 0
    case "${choice}" in
      0) Install-Skills >/dev/null || ccq_ui_warning "Skills 安装失败" ;;
      1) Update-Skills >/dev/null || ccq_ui_warning "Skills 更新失败" ;;
      2) Uninstall-Skills >/dev/null || ccq_ui_warning "Skills 卸载失败" ;;
      3) return 0 ;;
    esac
  done
}
