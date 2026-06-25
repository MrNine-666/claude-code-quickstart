#!/usr/bin/env zsh
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

  CCQ_BOOTSTRAP_GROUP_BASIC=(NodeJS Git ClaudeCode)
  CCQ_BOOTSTRAP_STEP_IDS=(NodeJS Git ClaudeCode)

  CCQ_BOOTSTRAP_STEP_NAME[NodeJS]="Node.js"
  CCQ_BOOTSTRAP_STEP_NAME[Git]="Git"
  CCQ_BOOTSTRAP_STEP_NAME[ClaudeCode]="Claude Code"

  CCQ_BOOTSTRAP_STEP_DESCRIPTION[NodeJS]="通过 nvm 官方脚本安装 Node.js LTS 并验证 node/npm"
  CCQ_BOOTSTRAP_STEP_DESCRIPTION[Git]="通过 Homebrew 安装 Git 并应用推荐配置"
  CCQ_BOOTSTRAP_STEP_DESCRIPTION[ClaudeCode]="通过 npm 全局安装 Claude Code CLI"

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

  CCQ_BOOTSTRAP_STEP_DEPS[ClaudeCode]="NodeJS"
  CCQ_BOOTSTRAP_STEP_UPDATE[ClaudeCode]="Update-ClaudeCode"
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
        NodeJS|Git|ClaudeCode) printf 'Basic' ;;
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
        Description) printf 'Claude Code 最小可用环境' ;;
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
