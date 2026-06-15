#!/usr/bin/env zsh
# Provider.legacy.zsh - 供应商管理核心模块（CRUD + 同步 + 切换 + Dashboard）【已废弃】
# 功能: 承载全部供应商业务逻辑，供 steps/ApiKey.zsh 安装与 Manage.zsh 管理复用
# 依赖: Ui.zsh, Json.zsh（须在本模块之前加载）
#
# ⚠️ DEPRECATED: 本文件已被 provider-manager.js 替代（管理面板统一到 Node.js）
# 保留原因: 作为回滚备份，验证期后将移除
# 新实现: installer/contracts/scripts/provider-manager.js
# 迁移时间: 2026-06-15

if [ -n "${CCQ_PROVIDER_ZSH_LOADED:-}" ]; then
  return 0 2>/dev/null || exit 0
fi
CCQ_PROVIDER_ZSH_LOADED=1

: "${CCQ_PROVIDER_CONTRACT:=${CCQ_CONTRACTS_DIR:-${CCQ_INSTALLER_ROOT}/contracts}/providers.json}"

# ─── 路径助手 ───────────────────────────────────────────────────────────────

ccq_provider_settings_path() { printf '%s\n' "${HOME}/.claude/settings.json"; }
ccq_provider_profiles_dir() { printf '%s\n' "${HOME}/.claude/providers"; }
ccq_claude_json_path() { printf '%s\n' "${HOME}/.claude.json"; }

ccq_provider_valid_key() {
  local key="${1:-}"
  case "${key}" in
    ''|*[!A-Za-z0-9._-]*) return 1 ;;
    *) return 0 ;;
  esac
}

ccq_provider_profile_path() {
  local key="${1:-}"
  ccq_provider_valid_key "${key}" || return 1
  printf '%s/%s.json\n' "$(ccq_provider_profiles_dir)" "${key}"
}

# ─── 契约访问 ───────────────────────────────────────────────────────────────

ccq_provider_contract_node() {
  command -v node >/dev/null 2>&1 || return 1
  [ -f "${CCQ_PROVIDER_CONTRACT}" ] || return 1
}

ccq_provider_builtin_lines() {
  ccq_provider_contract_node || return 1
  node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
for (const [key, p] of Object.entries(c.BuiltinProviders || {})) {
  console.log([key, p.Name || key, p.Description || ""].map(v => String(v).replace(/[\t\r\n]+/g, " ")).join("\t"));
}
' "${CCQ_PROVIDER_CONTRACT}"
}

ccq_provider_builtin_or_self() {
  local key="${1:-}"
  local builtin_key
  builtin_key="$(ccq_provider_builtin_key_from_profile_key "${key}" 2>/dev/null || true)"
  printf '%s' "${builtin_key:-${key}}"
}

ccq_provider_get_builtin_field() {
  local key="${1:-}"
  local field="${2:-}"
  ccq_provider_contract_node || return 1
  key="$(ccq_provider_builtin_or_self "${key}")"
  node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const p = (c.BuiltinProviders || {})[process.argv[2]] || {};
const value = p[process.argv[3]] || "";
process.stdout.write(String(value));
' "${CCQ_PROVIDER_CONTRACT}" "${key}" "${field}"
}

ccq_provider_builtin_extra_summary() {
  local key="${1:-}"
  ccq_provider_contract_node || return 1
  key="$(ccq_provider_builtin_or_self "${key}")"
  node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const p = (c.BuiltinProviders || {})[process.argv[2]] || {};
const parts = [];
for (const [k, v] of Object.entries(p.ExtraEnv || {})) {
  if (v !== undefined && v !== null && String(v).trim()) parts.push(`${k}=${v}`);
}
process.stdout.write(parts.join(", "));
' "${CCQ_PROVIDER_CONTRACT}" "${key}"
}

ccq_provider_requires_model_config() {
  local key="${1:-}"
  ccq_provider_contract_node || return 1
  key="$(ccq_provider_builtin_or_self "${key}")"
  node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const p = (c.BuiltinProviders || {})[process.argv[2]] || {};
process.exit(p.RequireModelConfig ? 0 : 1);
' "${CCQ_PROVIDER_CONTRACT}" "${key}"
}

ccq_provider_match_builtin_key() {
  local base_url="${1:-}"
  ccq_provider_contract_node || return 1
  BASE_URL="${base_url}" node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const norm = (v) => String(v || "").trim().replace(/\/+$/, "");
const target = norm(process.env.BASE_URL);
for (const [k, p] of Object.entries(c.BuiltinProviders || {})) {
  if (k === "custom") continue;
  const b = norm(p.BaseUrl);
  if (b && (b === target || target.startsWith(b + "/"))) { process.stdout.write(k); process.exit(0); }
}
process.stdout.write("custom");
' "${CCQ_PROVIDER_CONTRACT}"
}

ccq_provider_builtin_key_from_profile_key() {
  local key="${1:-}"
  [ -n "${key}" ] || return 1
  ccq_provider_contract_node || return 1
  PROFILE_KEY="${key}" node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const key = process.env.PROFILE_KEY || "";
for (const builtinKey of Object.keys(c.BuiltinProviders || {})) {
  if (builtinKey === "custom") continue;
  const escaped = builtinKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (key === builtinKey || new RegExp(`^${escaped}-\\d+$`).test(key)) {
    process.stdout.write(builtinKey);
    process.exit(0);
  }
}
if (key === "custom") process.stdout.write("custom");
' "${CCQ_PROVIDER_CONTRACT}"
}

ccq_provider_next_available_key() {
  local base_key="${1:-}"
  ccq_provider_valid_key "${base_key}" || return 1
  PROFILES_DIR="$(ccq_provider_profiles_dir)" BASE_KEY="${base_key}" node -e '
const fs = require("fs");
const path = require("path");
const dir = process.env.PROFILES_DIR;
const base = process.env.BASE_KEY;
const exists = (key) => fs.existsSync(path.join(dir, `${key}.json`));
if (!fs.existsSync(dir) || !exists(base)) { process.stdout.write(base); process.exit(0); }
const escaped = base.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`^${escaped}(?:-(\\d+))?\\.json$`);
let max = 1;
for (const file of fs.readdirSync(dir)) {
  const m = file.match(pattern);
  if (!m) continue;
  if (m[1]) max = Math.max(max, Number(m[1]) || 1);
}
process.stdout.write(`${base}-${max + 1}`);
'
}

ccq_provider_custom_key() {
  local provider_name="${1:-}"
  local base_url="${2:-}"
  local current_key="${3:-}"
  PROFILES_DIR="$(ccq_provider_profiles_dir)" PROVIDER_NAME="${provider_name}" PROVIDER_BASE_URL="${base_url}" CURRENT_KEY="${current_key}" node -e '
const fs = require("fs");
const path = require("path");
const crypto = require("crypto");
function slug(value) {
  return String(value || "")
    .trim()
    .toLowerCase()
    .normalize("NFKD")
    .replace(/[^a-z0-9-]+/g, "-")
    .replace(/-{2,}/g, "-")
    .replace(/^-|-$/g, "");
}
let key = slug(process.env.PROVIDER_NAME);
if (!key) {
  try {
    const u = new URL(String(process.env.PROVIDER_BASE_URL || "").replace(/\/+$/, ""));
    key = slug(u.hostname.replace(/\./g, "-"));
    if (u.pathname && u.pathname !== "/") {
      key = `${key}-${crypto.createHash("sha1").update(u.pathname).digest("hex").slice(0, 4)}`;
    }
  } catch (_) {
    key = "manual";
  }
}
key = `custom-${key || "manual"}`;
const dir = process.env.PROFILES_DIR;
const currentKey = process.env.CURRENT_KEY || "";
const exists = (candidate) => candidate !== currentKey && fs.existsSync(path.join(dir, `${candidate}.json`));
if (!fs.existsSync(dir) || !exists(key)) { process.stdout.write(key); process.exit(0); }
const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`^${escaped}(?:-(\\d+))?\\.json$`);
let max = 1;
for (const file of fs.readdirSync(dir)) {
  const m = file.match(pattern);
  if (!m) continue;
  if (m[1]) max = Math.max(max, Number(m[1]) || 1);
}
process.stdout.write(`${key}-${max + 1}`);
'
}

# ─── TTY 与输入 ─────────────────────────────────────────────────────────────

ccq_provider_tty() {
  [ -r /dev/tty ] && [ -w /dev/tty ]
}

ccq_provider_prompt_secret() {
  local prompt="${1:-API Key}"
  local value=""
  ccq_provider_tty || return 1
  printf '%s: ' "${prompt}" >/dev/tty
  IFS= read -r -s value </dev/tty || return 1
  printf '\n' >/dev/tty
  printf '%s' "${value}"
}

ccq_provider_prompt_text() {
  local prompt="${1:-请输入}"
  local default_value="${2:-}"
  local value=""
  ccq_provider_tty || return 1
  if [ -n "${default_value}" ]; then
    printf '%s [%s]: ' "${prompt}" "${default_value}" >/dev/tty
    IFS= read -r value </dev/tty || return 1
    printf '%s' "${value:-${default_value}}"
  else
    printf '%s: ' "${prompt}" >/dev/tty
    IFS= read -r value </dev/tty || return 1
    printf '%s' "${value}"
  fi
}

ccq_provider_is_number() {
  local value="${1:-}"
  case "${value}" in
    ''|*[!0-9]*) return 1 ;;
    *) return 0 ;;
  esac
}

ccq_provider_wait_key() {
  local prompt="${1:-按任意键继续...}"
  local _key
  ccq_provider_tty || return 0
  printf '\n%s' "${prompt}" >/dev/tty
  IFS= read -r -s -k 1 _key </dev/tty || true
  printf '\n' >/dev/tty
}

ccq_provider_read_dashboard_key() {
  local key next third
  IFS= read -r -s -k 1 key </dev/tty || return 1
  case "${key}" in
    $'\033')
      if IFS= read -r -s -k 1 -t 0.08 next </dev/tty 2>/dev/null; then
        if [ "${next}" = "[" ]; then
          IFS= read -r -s -k 1 -t 0.08 third </dev/tty 2>/dev/null || third=""
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
    a|A) printf 'add\n' ;;
    e|E) printf 'edit\n' ;;
    m|M) printf 'model\n' ;;
    d|D) printf 'delete\n' ;;
    q|Q) printf 'escape\n' ;;
    *) printf 'other\n' ;;
  esac
}

# ─── Profile 模型与额外 env ─────────────────────────────────────────────────

ccq_provider_managed_model_env_json() {
  local profile_path="${1:-}"
  [ -f "${profile_path}" ] || { printf '{}\n'; return 0; }
  ccq_provider_contract_node || return 1
  PROFILE_PATH="${profile_path}" node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const profile = JSON.parse(fs.readFileSync(process.env.PROFILE_PATH, "utf8"));
const managed = contract.ManagedEnv || {};
const keys = managed.ProviderManagedModelEnvKeys || [];
const legacyKey = managed.LegacyProviderModelKey || "modelMapping";
const result = {};
function put(key, value) {
  if (keys.includes(key) && value !== undefined && value !== null && String(value).trim()) result[key] = String(value);
}
if (profile.modelEnv && typeof profile.modelEnv === "object" && !Array.isArray(profile.modelEnv)) {
  for (const key of keys) put(key, profile.modelEnv[key]);
  if (Object.keys(result).length) { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exit(0); }
}
const legacy = profile[legacyKey];
if (legacy && typeof legacy === "object" && !Array.isArray(legacy)) {
  put("ANTHROPIC_DEFAULT_HAIKU_MODEL", legacy.haiku);
  put("ANTHROPIC_DEFAULT_OPUS_MODEL", legacy.opus);
  put("ANTHROPIC_DEFAULT_SONNET_MODEL", legacy.sonnet);
  if (Object.keys(result).length) { process.stdout.write(JSON.stringify(result, null, 2) + "\n"); process.exit(0); }
}
if (profile.env && typeof profile.env === "object" && !Array.isArray(profile.env)) {
  for (const key of keys) put(key, profile.env[key]);
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
' "${CCQ_PROVIDER_CONTRACT}"
}

ccq_provider_set_model_env_json() {
  local profile_path="${1:-}"
  local model_env_json="${2:-{}}"
  [ -f "${profile_path}" ] || return 1
  ccq_provider_contract_node || return 1
  MODEL_ENV_JSON="${model_env_json}" PROFILE_PATH="${profile_path}" node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const profile = JSON.parse(fs.readFileSync(process.env.PROFILE_PATH, "utf8"));
const managed = contract.ManagedEnv || {};
const keys = managed.ProviderManagedModelEnvKeys || [];
const legacyKey = managed.LegacyProviderModelKey || "modelMapping";
let modelEnv = {};
try { modelEnv = JSON.parse(process.env.MODEL_ENV_JSON || "{}"); } catch (_) { modelEnv = {}; }
if (!profile.env || typeof profile.env !== "object" || Array.isArray(profile.env)) profile.env = {};
delete profile[legacyKey];
for (const key of keys) delete profile.env[key];
const normalized = {};
for (const key of keys) {
  const value = modelEnv[key];
  if (value !== undefined && value !== null && String(value).trim()) normalized[key] = String(value);
}
if (Object.keys(normalized).length) profile.modelEnv = normalized;
else delete profile.modelEnv;
if (!profile._meta || typeof profile._meta !== "object" || Array.isArray(profile._meta)) profile._meta = {};
profile._meta.updatedAt = new Date().toISOString();
process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
' "${CCQ_PROVIDER_CONTRACT}"
}

ccq_provider_model_summary() {
  local profile_path="${1:-}"
  [ -f "${profile_path}" ] || { printf '未配置'; return 0; }
  ccq_provider_contract_node || { printf '未配置'; return 0; }
  PROFILE_PATH="${profile_path}" node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const profile = JSON.parse(fs.readFileSync(process.env.PROFILE_PATH, "utf8"));
const managed = contract.ManagedEnv || {};
const keys = managed.ProviderManagedModelEnvKeys || [];
const labels = managed.ProviderModelEnvLabels || {};
const legacyKey = managed.LegacyProviderModelKey || "modelMapping";
const result = {};
function put(key, value) {
  if (keys.includes(key) && value !== undefined && value !== null && String(value).trim()) result[key] = String(value);
}
if (profile.modelEnv && typeof profile.modelEnv === "object" && !Array.isArray(profile.modelEnv)) {
  for (const key of keys) put(key, profile.modelEnv[key]);
}
if (!Object.keys(result).length && profile[legacyKey] && typeof profile[legacyKey] === "object" && !Array.isArray(profile[legacyKey])) {
  put("ANTHROPIC_DEFAULT_HAIKU_MODEL", profile[legacyKey].haiku);
  put("ANTHROPIC_DEFAULT_OPUS_MODEL", profile[legacyKey].opus);
  put("ANTHROPIC_DEFAULT_SONNET_MODEL", profile[legacyKey].sonnet);
}
if (!Object.keys(result).length && profile.env && typeof profile.env === "object" && !Array.isArray(profile.env)) {
  for (const key of keys) put(key, profile.env[key]);
}
if (!Object.keys(result).length) { process.stdout.write("未配置"); process.exit(0); }
const preferred = ["ANTHROPIC_DEFAULT_HAIKU_MODEL", "ANTHROPIC_DEFAULT_OPUS_MODEL", "ANTHROPIC_DEFAULT_SONNET_MODEL"];
const parts = [];
for (const key of preferred) if (result[key]) parts.push(`${labels[key] || key}=${result[key]}`);
for (const key of keys) if (!preferred.includes(key) && result[key]) parts.push(`${labels[key] || key}=${result[key]}`);
process.stdout.write(parts.join(", "));
' "${CCQ_PROVIDER_CONTRACT}" 2>/dev/null || printf '未配置'
}

ccq_provider_effective_extra_env_json() {
  local key="${1:-}"
  local profile_path="${2:-}"
  [ -f "${profile_path}" ] || { printf '{}\n'; return 0; }
  ccq_provider_contract_node || return 1
  PROFILE_KEY="${key}" PROFILE_PATH="${profile_path}" node -e '
const fs = require("fs");
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const profile = JSON.parse(fs.readFileSync(process.env.PROFILE_PATH, "utf8"));
const managedExtraKeys = (contract.ManagedEnv || {}).ProviderManagedExtraEnvKeys || [];
const builtins = contract.BuiltinProviders || {};
const profileKey = process.env.PROFILE_KEY || "";
let builtinKey = "";
for (const key of Object.keys(builtins)) {
  if (key === "custom") continue;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (profileKey === key || new RegExp(`^${escaped}-\\d+$`).test(profileKey)) { builtinKey = key; break; }
}
const result = {};
if (builtinKey && builtins[builtinKey]?.ExtraEnv) {
  for (const [k, v] of Object.entries(builtins[builtinKey].ExtraEnv)) {
    if (managedExtraKeys.includes(k) && v !== undefined && v !== null && String(v).trim()) result[k] = String(v);
  }
}
if (profile.env && typeof profile.env === "object" && !Array.isArray(profile.env)) {
  for (const key of managedExtraKeys) {
    const value = profile.env[key];
    if (value !== undefined && value !== null && String(value).trim()) result[key] = String(value);
  }
}
process.stdout.write(JSON.stringify(result, null, 2) + "\n");
' "${CCQ_PROVIDER_CONTRACT}"
}

ccq_provider_read_model_env() {
  ccq_provider_contract_node || return 1
  local output=""
  output="$(node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const labels = c.ManagedEnv.ProviderModelEnvLabels || {};
for (const key of c.ManagedEnv.ProviderManagedModelEnvKeys || []) {
  console.log([key, labels[key] || key].join("\t"));
}
' "${CCQ_PROVIDER_CONTRACT}")" || return 1

  local patch="{}" line key label value
  while IFS= read -r line; do
    [ -n "${line}" ] || continue
    key="${line%%$'\t'*}"
    label="${line#*$'\t'}"
    value="$(ccq_provider_prompt_text "${label} (${key})，留空跳过" "")"
    if [ -n "${value}" ]; then
      patch="$(MODEL_KEY="${key}" MODEL_VALUE="${value}" PATCH_JSON="${patch}" node -e '
const patch = JSON.parse(process.env.PATCH_JSON || "{}");
patch[process.env.MODEL_KEY] = process.env.MODEL_VALUE;
console.log(JSON.stringify(patch));
')" || return 1
    fi
  done <<EOF
${output}
EOF
  printf '%s\n' "${patch}"
}

# ─── Profile 构建与切换 ─────────────────────────────────────────────────────

ccq_provider_build_profile_json() {
  local key="${1:-}"
  local provider_name="${2:-}"
  local base_url="${3:-}"
  local api_key="${4:-}"
  local model_env_json="${5:-{}}"
  [ -z "${model_env_json}" ] && model_env_json="{}"
  ccq_provider_contract_node || return 1
  printf '%s' "${api_key}" | PROVIDER_KEY="${key}" PROVIDER_NAME="${provider_name}" PROVIDER_BASE_URL="${base_url}" MODEL_ENV_JSON="${model_env_json}" node -e '
const fs = require("fs");
const apiKey = fs.readFileSync(0, "utf8");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const key = process.env.PROVIDER_KEY;
let builtinKey = key;
for (const candidate of Object.keys(c.BuiltinProviders || {})) {
  if (candidate === "custom") continue;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (key === candidate || new RegExp(`^${escaped}-\\d+$`).test(key)) { builtinKey = candidate; break; }
}
const builtin = (c.BuiltinProviders || {})[builtinKey] || {};
let modelEnv = {};
try { modelEnv = JSON.parse(process.env.MODEL_ENV_JSON || "{}"); } catch (_) { modelEnv = {}; }
const profile = {
  _meta: {
    provider: process.env.PROVIDER_NAME,
    key,
    baseUrl: process.env.PROVIDER_BASE_URL,
    configuredAt: new Date().toISOString()
  },
  env: {
    ANTHROPIC_AUTH_TOKEN: apiKey,
    ANTHROPIC_BASE_URL: process.env.PROVIDER_BASE_URL
  }
};
for (const [k, v] of Object.entries(builtin.ExtraEnv || {})) {
  if (v !== undefined && v !== null && String(v).trim()) profile.env[k] = String(v);
}
const finalModelEnv = Object.keys(modelEnv).length ? modelEnv : (builtin.ModelEnv || {});
if (Object.keys(finalModelEnv).length) profile.modelEnv = finalModelEnv;
process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
' "${CCQ_PROVIDER_CONTRACT}"
}

ccq_provider_switch_profile() {
  local profile_path="${1:-}"
  local settings_path profile_key merged_json
  [ -f "${profile_path}" ] || return 1
  settings_path="$(ccq_provider_settings_path)"
  profile_key="$(basename "${profile_path}" .json)"
  ccq_provider_contract_node || return 1
  merged_json="$(SETTINGS_PATH="${settings_path}" PROFILE_PATH="${profile_path}" PROFILE_KEY="${profile_key}" node -e '
const fs = require("fs");
const settingsPath = process.env.SETTINGS_PATH;
const profilePath = process.env.PROFILE_PATH;
const profileKey = process.env.PROFILE_KEY;
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const managed = contract.ManagedEnv || {};
const profile = JSON.parse(fs.readFileSync(profilePath, "utf8"));
let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (raw) settings = JSON.parse(raw);
}
if (!settings.env || typeof settings.env !== "object" || Array.isArray(settings.env)) settings.env = {};
const env = settings.env;
const authKey = managed.AuthTokenKey || "ANTHROPIC_AUTH_TOKEN";
const baseKey = managed.BaseUrlKey || "ANTHROPIC_BASE_URL";
const modelKeys = managed.ProviderManagedModelEnvKeys || [];
const extraKeys = managed.ProviderManagedExtraEnvKeys || [];
const legacyKey = managed.LegacyProviderModelKey || "modelMapping";
for (const key of [authKey, baseKey, ...modelKeys, ...extraKeys]) delete env[key];
delete settings[legacyKey];
if (profile.env && typeof profile.env === "object" && !Array.isArray(profile.env)) {
  if (profile.env[authKey] !== undefined && profile.env[authKey] !== null && String(profile.env[authKey]).trim()) env[authKey] = String(profile.env[authKey]);
  if (profile.env[baseKey] !== undefined && profile.env[baseKey] !== null && String(profile.env[baseKey]).trim()) env[baseKey] = String(profile.env[baseKey]);
}
const modelEnv = {};
function putModel(key, value) {
  if (modelKeys.includes(key) && value !== undefined && value !== null && String(value).trim()) modelEnv[key] = String(value);
}
if (profile.modelEnv && typeof profile.modelEnv === "object" && !Array.isArray(profile.modelEnv)) {
  for (const key of modelKeys) putModel(key, profile.modelEnv[key]);
}
if (!Object.keys(modelEnv).length && profile[legacyKey] && typeof profile[legacyKey] === "object" && !Array.isArray(profile[legacyKey])) {
  putModel("ANTHROPIC_DEFAULT_HAIKU_MODEL", profile[legacyKey].haiku);
  putModel("ANTHROPIC_DEFAULT_OPUS_MODEL", profile[legacyKey].opus);
  putModel("ANTHROPIC_DEFAULT_SONNET_MODEL", profile[legacyKey].sonnet);
}
if (!Object.keys(modelEnv).length && profile.env && typeof profile.env === "object" && !Array.isArray(profile.env)) {
  for (const key of modelKeys) putModel(key, profile.env[key]);
}
for (const [key, value] of Object.entries(modelEnv)) env[key] = value;
const builtins = contract.BuiltinProviders || {};
let builtinKey = "";
for (const key of Object.keys(builtins)) {
  if (key === "custom") continue;
  const escaped = key.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (profileKey === key || new RegExp(`^${escaped}-\\d+$`).test(profileKey)) { builtinKey = key; break; }
}
const extraEnv = {};
if (builtinKey && builtins[builtinKey]?.ExtraEnv) {
  for (const [key, value] of Object.entries(builtins[builtinKey].ExtraEnv)) {
    if (extraKeys.includes(key) && value !== undefined && value !== null && String(value).trim()) extraEnv[key] = String(value);
  }
}
if (profile.env && typeof profile.env === "object" && !Array.isArray(profile.env)) {
  for (const key of extraKeys) {
    const value = profile.env[key];
    if (value !== undefined && value !== null && String(value).trim()) extraEnv[key] = String(value);
  }
}
for (const [key, value] of Object.entries(extraEnv)) env[key] = value;
process.stdout.write(JSON.stringify(settings, null, 2) + "\n");
' "${CCQ_PROVIDER_CONTRACT}")" || return 1
  ccq_json_write_atomic "${settings_path}" "${merged_json}"
}

ccq_provider_write_onboarding() {
  local claude_json_path merged_json
  claude_json_path="$(ccq_claude_json_path)"
  merged_json="$(node -e '
const fs = require("fs");
const target = process.argv[1];
let data = {};
if (fs.existsSync(target)) {
  const raw = fs.readFileSync(target, "utf8").trim();
  if (raw) data = JSON.parse(raw);
}
data.hasCompletedOnboarding = true;
process.stdout.write(JSON.stringify(data, null, 2) + "\n");
' "${claude_json_path}")" || return 1
  ccq_json_write_atomic "${claude_json_path}" "${merged_json}"
}

# ─── 选择与匹配 ─────────────────────────────────────────────────────────────

ccq_provider_builtin_profile_lines() {
  local builtin_key="${1:-}"
  ccq_provider_contract_node || return 1
  PROFILES_DIR="$(ccq_provider_profiles_dir)" BUILTIN_KEY="${builtin_key}" node -e '
const fs = require("fs");
const path = require("path");
const dir = process.env.PROFILES_DIR;
const builtinKey = process.env.BUILTIN_KEY;
if (!fs.existsSync(dir)) process.exit(0);
const escaped = builtinKey.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
const pattern = new RegExp(`^${escaped}(?:-\\d+)?\\.json$`);
for (const file of fs.readdirSync(dir).filter(f => pattern.test(f)).sort()) {
  try {
    const fullPath = path.join(dir, file);
    const profile = JSON.parse(fs.readFileSync(fullPath, "utf8"));
    const key = path.basename(file, ".json");
    const meta = profile._meta || {};
    const env = profile.env || {};
    const row = [key, meta.provider || key, meta.baseUrl || env.ANTHROPIC_BASE_URL || ""];
    console.log(row.map(v => String(v).replace(/[\t\r\n]+/g, " ")).join("\t"));
  } catch (_) {}
}
'
}

ccq_provider_select_builtin() {
  local lines line key name desc options=() keys=() tag matched count template_name first_name truncated_name
  ccq_provider_tty || return 1
  lines="$(ccq_provider_builtin_lines)" || return 1
  for line in ${(f)lines}; do
    [ -n "${line}" ] || continue
    key="${line%%$'\t'*}"
    local rest="${line#*$'\t'}"
    name="${rest%%$'\t'*}"
    desc="${rest#*$'\t'}"
    tag=""
    if [ "${key}" != "custom" ]; then
      matched="$(ccq_provider_builtin_profile_lines "${key}" 2>/dev/null || true)"
      count=0
      first_name=""
      while IFS= read -r matched_line; do
        [ -n "${matched_line}" ] || continue
        count=$((count + 1))
        [ -z "${first_name}" ] && first_name="${matched_line#*$'\t'}" && first_name="${first_name%%$'\t'*}"
      done <<EOF
${matched}
EOF
      if [ "${count}" -eq 1 ]; then
        template_name="${name}"
        if [ "${first_name}" = "${template_name}" ]; then
          tag=" [已配置]"
        else
          truncated_name="$(ccq_provider_truncate_display "${first_name}" 10)"
          tag=" [已配置: ${truncated_name}]"
        fi
      elif [ "${count}" -gt 1 ]; then
        tag=" [已配置 x${count}]"
      fi
    fi
    keys+=("${key}")
    options+=("${name} - ${desc}${tag}")
  done

  local selected_index
  selected_index="$(ccq_show_single_select_menu "请选择第三方供应商" 0 "${options[@]}")" || return 1
  printf '%s\n' "${keys[$((selected_index + 1))]}"
}

ccq_provider_env_value_exists() {
  local file_path="${1:-}"
  local path_expr="${2:-}"
  local value
  value="$(ccq_json_get "${file_path}" "${path_expr}" 2>/dev/null || true)"
  [ -n "${value}" ]
}

ccq_provider_base_url_matches() {
  local settings_base="${1:-}"
  local profile_base="${2:-}"
  node -e '
const normalize = (value) => String(value || "").trim().replace(/\/+$/, "");
const settingsBase = normalize(process.argv[1]);
const profileBase = normalize(process.argv[2]);
process.exit(settingsBase && profileBase && (settingsBase === profileBase || settingsBase.startsWith(`${profileBase}/`)) ? 0 : 1);
' "${settings_base}" "${profile_base}" 2>/dev/null
}

ccq_provider_auth_token_matches() {
  local settings_token="${1:-}"
  local profile_token="${2:-}"
  [ -n "${settings_token}" ] && [ -n "${profile_token}" ] && [ "${settings_token}" = "${profile_token}" ]
}

# ─── 活跃供应商解析 ─────────────────────────────────────────────────────────

ccq_provider_active_base_url() {
  local settings_path
  settings_path="$(ccq_provider_settings_path)"
  ccq_json_get "${settings_path}" "env.ANTHROPIC_BASE_URL" 2>/dev/null || true
}

ccq_provider_active_auth_token() {
  local settings_path
  settings_path="$(ccq_provider_settings_path)"
  ccq_json_get "${settings_path}" "env.ANTHROPIC_AUTH_TOKEN" 2>/dev/null || true
}

ccq_provider_profile_field() {
  local profile_path="${1:-}"
  local field="${2:-provider}"
  [ -f "${profile_path}" ] || return 1
  node -e '
const fs = require("fs");
const profile = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const field = process.argv[2];
const meta = profile._meta || {};
const env = profile.env || {};
if (field === "key") process.stdout.write(meta.key || "");
else if (field === "provider") process.stdout.write(meta.provider || "");
else if (field === "baseUrl") process.stdout.write(meta.baseUrl || env.ANTHROPIC_BASE_URL || "");
else if (field === "authToken") process.stdout.write(env.ANTHROPIC_AUTH_TOKEN || "");
else process.stdout.write("");
' "${profile_path}" "${field}"
}

ccq_provider_resolve_active_key() {
  local profiles_dir active_base active_token file key base_url profile_token
  local first_base_key="" token_match_key="" has_profile_token=0
  profiles_dir="$(ccq_provider_profiles_dir)"
  active_base="$(ccq_provider_active_base_url)"
  active_token="$(ccq_provider_active_auth_token)"
  [ -d "${profiles_dir}" ] && [ -n "${active_base}" ] || return 0

  for file in "${profiles_dir}"/*.json; do
    [ -f "${file}" ] || continue
    base_url="$(ccq_provider_profile_field "${file}" baseUrl)"
    ccq_provider_base_url_matches "${active_base}" "${base_url}" || continue
    key="$(basename "${file}" .json)"
    [ -z "${first_base_key}" ] && first_base_key="${key}"
    profile_token="$(ccq_provider_profile_field "${file}" authToken)"
    if [ -n "${profile_token}" ]; then
      has_profile_token=1
      if ccq_provider_auth_token_matches "${active_token}" "${profile_token}"; then
        token_match_key="${key}"
        break
      fi
    fi
  done

  if [ -n "${token_match_key}" ]; then
    printf '%s' "${token_match_key}"
  elif [ -z "${active_token}" ] || [ "${has_profile_token}" = "0" ]; then
    printf '%s' "${first_base_key}"
  fi
}

# ─── 从 settings.json 同步迁移（旧用户）─────────────────────────────────────

ccq_provider_sync_from_settings() {
  local settings_path active_base active_token key name profile_json profile_path
  settings_path="$(ccq_provider_settings_path)"
  [ -f "${settings_path}" ] || return 0
  active_base="$(ccq_provider_active_base_url)"
  active_token="$(ccq_provider_active_auth_token)"
  [ -n "${active_base}" ] && [ -n "${active_token}" ] || return 0
  [ -z "$(ccq_provider_resolve_active_key)" ] || return 0
  ccq_provider_contract_node || return 0

  key="$(ccq_provider_match_builtin_key "${active_base}")"
  [ -n "${key}" ] || key="custom"
  if [ "${key}" = "custom" ]; then
    name="自定义供应商"
    key="$(ccq_provider_custom_key "" "${active_base}")"
  else
    name="$(ccq_provider_get_builtin_field "${key}" Name)"
    key="$(ccq_provider_next_available_key "${key}")"
  fi

  profile_path="$(ccq_provider_profile_path "${key}")" || return 0
  profile_json="$(SETTINGS_PATH="${settings_path}" PROVIDER_KEY="${key}" PROVIDER_NAME="${name}" PROVIDER_BASE_URL="${active_base}" PROVIDER_TOKEN="${active_token}" node -e '
const fs = require("fs");
const settingsPath = process.env.SETTINGS_PATH;
const contract = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const managed = contract.ManagedEnv || {};
const settings = fs.existsSync(settingsPath) ? JSON.parse(fs.readFileSync(settingsPath, "utf8") || "{}") : {};
const env = settings.env || {};
const key = process.env.PROVIDER_KEY;
const builtins = contract.BuiltinProviders || {};
let builtinKey = "";
for (const candidate of Object.keys(builtins)) {
  if (candidate === "custom") continue;
  const escaped = candidate.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  if (key === candidate || new RegExp(`^${escaped}-\\d+$`).test(key)) { builtinKey = candidate; break; }
}
const profile = {
  _meta: {
    provider: process.env.PROVIDER_NAME,
    key,
    baseUrl: process.env.PROVIDER_BASE_URL,
    configuredAt: new Date().toISOString()
  },
  env: {
    ANTHROPIC_AUTH_TOKEN: process.env.PROVIDER_TOKEN,
    ANTHROPIC_BASE_URL: process.env.PROVIDER_BASE_URL
  }
};
const modelKeys = managed.ProviderManagedModelEnvKeys || [];
const legacyKey = managed.LegacyProviderModelKey || "modelMapping";
const modelEnv = {};
function putModel(k, v) { if (modelKeys.includes(k) && v !== undefined && v !== null && String(v).trim()) modelEnv[k] = String(v); }
if (settings[legacyKey] && typeof settings[legacyKey] === "object" && !Array.isArray(settings[legacyKey])) {
  putModel("ANTHROPIC_DEFAULT_HAIKU_MODEL", settings[legacyKey].haiku);
  putModel("ANTHROPIC_DEFAULT_OPUS_MODEL", settings[legacyKey].opus);
  putModel("ANTHROPIC_DEFAULT_SONNET_MODEL", settings[legacyKey].sonnet);
}
for (const modelKey of modelKeys) putModel(modelKey, env[modelKey]);
if (Object.keys(modelEnv).length) profile.modelEnv = modelEnv;
const extraKeys = managed.ProviderManagedExtraEnvKeys || [];
if (builtinKey && builtins[builtinKey]?.ExtraEnv) {
  for (const [k, v] of Object.entries(builtins[builtinKey].ExtraEnv)) {
    if (extraKeys.includes(k) && v !== undefined && v !== null && String(v).trim()) profile.env[k] = String(v);
  }
}
for (const extraKey of extraKeys) {
  const value = env[extraKey];
  if (value !== undefined && value !== null && String(value).trim()) profile.env[extraKey] = String(value);
}
process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
' "${CCQ_PROVIDER_CONTRACT}")" || return 0
  ccq_json_write_atomic "${profile_path}" "${profile_json}" >/dev/null 2>&1 || return 0
}

# ─── 展示数据与状态表 ───────────────────────────────────────────────────────

ccq_provider_display_lines() {
  ccq_provider_contract_node || return 1
  PROFILES_DIR="$(ccq_provider_profiles_dir)" SETTINGS_PATH="$(ccq_provider_settings_path)" node -e '
const fs = require("fs");
const path = require("path");
const dir = process.env.PROFILES_DIR;
const settingsPath = process.env.SETTINGS_PATH;
function clean(value) { return String(value || "").replace(/[\t\r\n]+/g, " "); }
function norm(value) { return String(value || "").trim().replace(/\/+$/, ""); }
function mask(value) {
  const s = String(value || "");
  if (!s) return "-";
  if (s.length <= 8) return "***";
  return `${s.slice(0, 4)}...${s.slice(-2)}`;
}
function baseMatch(settingsBase, profileBase) {
  const s = norm(settingsBase);
  const p = norm(profileBase);
  return !!(s && p && (s === p || s.startsWith(`${p}/`)));
}
const profiles = [];
if (fs.existsSync(dir)) {
  for (const file of fs.readdirSync(dir).filter(f => f.endsWith(".json")).sort()) {
    try {
      const fullPath = path.join(dir, file);
      const profile = JSON.parse(fs.readFileSync(fullPath, "utf8"));
      const meta = profile._meta || {};
      const env = profile.env || {};
      profiles.push({
        key: path.basename(file, ".json"),
        name: meta.provider || path.basename(file, ".json"),
        baseUrl: meta.baseUrl || env.ANTHROPIC_BASE_URL || "",
        authToken: env.ANTHROPIC_AUTH_TOKEN || "",
        profilePath: fullPath
      });
    } catch (_) {}
  }
}
let settings = {};
if (fs.existsSync(settingsPath)) {
  const raw = fs.readFileSync(settingsPath, "utf8").trim();
  if (raw) settings = JSON.parse(raw);
}
const activeBase = settings.env?.ANTHROPIC_BASE_URL || "";
const activeToken = settings.env?.ANTHROPIC_AUTH_TOKEN || "";
let activeKey = "";
const baseMatches = profiles.filter(p => baseMatch(activeBase, p.baseUrl));
const tokenMatches = baseMatches.filter(p => activeToken && p.authToken && activeToken === p.authToken);
if (tokenMatches.length) activeKey = tokenMatches[0].key;
else if (!activeToken || !baseMatches.some(p => p.authToken)) activeKey = baseMatches[0]?.key || "";
for (const p of profiles) {
  console.log([p.key, clean(p.name), clean(p.baseUrl), mask(p.authToken), p.key === activeKey ? "true" : "false", clean(p.profilePath)].join("\t"));
}
'
}

ccq_provider_truncate_display() {
  local text="${1:-}"
  local width="${2:-0}"
  local current
  case "${width}" in ''|*[!0-9]*) width=0 ;; esac
  [ "${width}" -gt 0 ] || { printf '%s' "${text}"; return 0; }
  current="$(ccq_string_display_width "${text}")"
  if [ "${current}" -le "${width}" ]; then
    printf '%s' "${text}"
    return 0
  fi
  while [ -n "${text}" ] && [ "$(ccq_string_display_width "${text}...")" -gt "${width}" ]; do
    text="${text[1,-2]}"
  done
  printf '%s...' "${text}"
}

ccq_provider_write_line() {
  local type="${1:-info}"
  local message="${2:-}"
  local target="${CCQ_PROVIDER_RENDER_TARGET:-stdout}"
  if [ "${target}" = "tty" ]; then
    ccq_tty_write "${type}" "${message}"
  else
    ccq_ui_write "${type}" "${message}"
  fi
}

ccq_provider_write_part() {
  local type="${1:-info}"
  local message="${2:-}"
  local target="${CCQ_PROVIDER_RENDER_TARGET:-stdout}"
  if [ "${target}" = "tty" ]; then
    ccq_tty_write "${type}" "${message}" 0
  else
    ccq_ui_write "${type}" "${message}" essential 0
  fi
}

ccq_provider_render_table() {
  local selected_index="${1:-0}"
  shift || true
  local rows=("$@")
  local name_width=15 url_width=35 key_width=15 status_width=10
  local sep_width line row key name base_url masked_key is_active profile_path marker color status_text name_display url_display i=1

  ccq_provider_write_line info "  $(ccq_display_pad "供应商" "${name_width}") $(ccq_display_pad "Base URL" "${url_width}") $(ccq_display_pad "API Key" "${key_width}") $(ccq_display_pad "状态" "${status_width}")"
  sep_width=$((name_width + url_width + key_width + status_width + 3))
  ccq_provider_write_line dim "  $(ccq_repeat_char '-' "${sep_width}")"

  for row in "${rows[@]}"; do
    IFS=$'\t' read -r key name base_url masked_key is_active profile_path <<< "${row}"
    marker=" "
    color="dim"
    if [ $((i - 1)) -eq "${selected_index}" ]; then
      marker="►"
      color="primary"
    elif [ "${is_active}" = "true" ]; then
      color="success"
    fi
    status_text="Inactive"
    [ "${is_active}" = "true" ] && status_text="Active"
    name_display="$(ccq_provider_truncate_display "${name:-未知}" "${name_width}")"
    url_display="$(ccq_provider_truncate_display "${base_url:-}" "${url_width}")"
    line="${marker} $(ccq_display_pad "${name_display}" "${name_width}") $(ccq_display_pad "${url_display}" "${url_width}") $(ccq_display_pad "${masked_key:-'-'}" "${key_width}") $(ccq_display_pad "${status_text}" "${status_width}")"
    ccq_provider_write_line "${color}" "${line}"
    i=$((i + 1))
  done
}

ccq_provider_render_action_bar() {
  local has_providers="${1:-0}"
  ccq_provider_write_line dim ""
  if [ "${has_providers}" = "1" ]; then
    ccq_provider_write_part dim " ["
    ccq_provider_write_part info "↑↓"
    ccq_provider_write_part dim "] 移动  ["
    ccq_provider_write_part info "Enter"
    ccq_provider_write_part dim "] 切换活跃  ["
    ccq_provider_write_part info "A"
    ccq_provider_write_part dim "] 添加  ["
    ccq_provider_write_part info "E"
    ccq_provider_write_part dim "] 修改  ["
    ccq_provider_write_part info "M"
    ccq_provider_write_part dim "] 模型  ["
    ccq_provider_write_part info "D"
    ccq_provider_write_part dim "] 删除  ["
    ccq_provider_write_part info "Esc"
    ccq_provider_write_part dim "] 返回"
    printf '\n' >/dev/tty
  else
    ccq_provider_write_part dim " ["
    ccq_provider_write_part info "A"
    ccq_provider_write_part dim "] 添加  ["
    ccq_provider_write_part info "Esc"
    ccq_provider_write_part dim "] 返回"
    printf '\n' >/dev/tty
  fi
}

ccq_provider_show_dashboard_banner() {
  local logo_lines=(
    "  ██████╗  ██████╗  ██████╗ "
    " ██╔════╝ ██╔════╝ ██╔═══██╗"
    " ██║      ██║      ██║   ██║"
    " ██║      ██║      ██║▄▄ ██║"
    "  ╚██████╗ ╚██████╗ ╚██████╔╝"
    "  ╚═════╝  ╚═════╝  ╚══▀▀═╝ "
  )
  local line
  printf '\n' >/dev/tty
  for line in "${logo_lines[@]}"; do
    ccq_tty_write primary "${line}"
  done
  printf '\n' >/dev/tty
  ccq_tty_write primary "  供应商管理"
  printf '\n' >/dev/tty
}

ccq_provider_show_status() {
  local lines line rows=()
  ccq_provider_sync_from_settings
  lines="$(ccq_provider_display_lines 2>/dev/null || true)"
  ccq_ui_primary "供应商列表："
  if [ -z "${lines}" ]; then
    ccq_ui_warning "  尚未配置任何供应商"
    ccq_ui_dim "  提示: 使用 Manage.zsh --action Provider 添加供应商" "developer"
    return 0
  fi
  rows=( ${(f)lines} )
  CCQ_PROVIDER_RENDER_TARGET=stdout ccq_provider_render_table -1 "${rows[@]}"
}

# ─── CRUD ───────────────────────────────────────────────────────────────────

ccq_provider_switch_key() {
  local key="${1:-}"
  local profile_path name
  ccq_provider_valid_key "${key}" || return 1
  profile_path="$(ccq_provider_profile_path "${key}")" || return 1
  [ -f "${profile_path}" ] || return 1
  ccq_provider_switch_profile "${profile_path}" || return 1
  name="$(ccq_provider_profile_field "${profile_path}" provider 2>/dev/null || printf '%s' "${key}")"
  ccq_ui_success "已切换到: ${name:-${key}}"
}

ccq_provider_remove_key() {
  local key="${1:-}"
  local profile_path active_key confirm_index
  ccq_provider_valid_key "${key}" || { CCQ_PROVIDER_ERROR="非法 Provider Key"; return 1; }
  profile_path="$(ccq_provider_profile_path "${key}")" || return 1
  [ -f "${profile_path}" ] || { CCQ_PROVIDER_ERROR="供应商 Profile 不存在"; return 1; }
  active_key="$(ccq_provider_resolve_active_key)"
  if [ -n "${active_key}" ] && [ "${key}" = "${active_key}" ]; then
    CCQ_PROVIDER_ERROR="不能删除当前活跃供应商"
    return 1
  fi
  ccq_provider_tty || { CCQ_PROVIDER_ERROR="无 TTY，无法确认删除"; return 1; }
  confirm_index="$(ccq_show_single_select_menu "确认删除供应商 Profile: ${key}？" 1 "是，删除" "否，取消")" || { CCQ_PROVIDER_ERROR="已取消"; return 1; }
  [ "${confirm_index}" = "0" ] || { CCQ_PROVIDER_ERROR="已取消"; return 1; }
  rm -f "${profile_path}"
  ccq_ui_success "已删除供应商 Profile: ${key}"
}

ccq_provider_edit_model_env() {
  local key="${1:-}"
  local profile_path editable_json choice output line model_key label current new_value updated_json was_active
  ccq_provider_valid_key "${key}" || return 1
  profile_path="$(ccq_provider_profile_path "${key}")" || return 1
  [ -f "${profile_path}" ] || return 1
  ccq_provider_tty || return 1
  editable_json="$(ccq_provider_managed_model_env_json "${profile_path}" 2>/dev/null || printf '{}')"

  while true; do
    printf '\n' >/dev/tty
    ccq_tty_write primary "模型配置管理"
    printf '\n' >/dev/tty
    output="$(MODEL_JSON="${editable_json}" node -e '
const model = JSON.parse(process.env.MODEL_JSON || "{}");
const keys = Object.keys(model);
if (!keys.length) { console.log("  (无模型配置)"); process.exit(0); }
for (const [k, v] of Object.entries(model)) console.log(`  ${k} => ${v}`);
')"
    while IFS= read -r line; do
      [ -n "${line}" ] && ccq_tty_write info "${line}"
    done <<EOF
${output}
EOF
    printf '\n' >/dev/tty
    choice="$(ccq_show_single_select_menu "选择操作：" 0 "设置模型环境键" "清除全部模型配置" "返回")" || break
    case "${choice}" in
      0)
        output="$(node -e '
const fs = require("fs");
const c = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
const labels = c.ManagedEnv.ProviderModelEnvLabels || {};
for (const key of c.ManagedEnv.ProviderManagedModelEnvKeys || []) console.log([key, labels[key] || key].join("\t"));
' "${CCQ_PROVIDER_CONTRACT}")" || return 1
        while IFS= read -r line; do
          [ -n "${line}" ] || continue
          model_key="${line%%$'\t'*}"
          label="${line#*$'\t'}"
          current="$(MODEL_JSON="${editable_json}" MODEL_KEY="${model_key}" node -e 'const m=JSON.parse(process.env.MODEL_JSON||"{}"); process.stdout.write(m[process.env.MODEL_KEY] || "(未设置)");')"
          new_value="$(ccq_provider_prompt_text "${label} (${model_key}) [${current}]，留空保持不变，输入 - 删除" "")" || return 1
          if [ "${new_value}" = "-" ]; then
            editable_json="$(MODEL_JSON="${editable_json}" MODEL_KEY="${model_key}" node -e 'const m=JSON.parse(process.env.MODEL_JSON||"{}"); delete m[process.env.MODEL_KEY]; console.log(JSON.stringify(m));')"
          elif [ -n "${new_value}" ]; then
            editable_json="$(MODEL_JSON="${editable_json}" MODEL_KEY="${model_key}" MODEL_VALUE="${new_value}" node -e 'const m=JSON.parse(process.env.MODEL_JSON||"{}"); m[process.env.MODEL_KEY]=process.env.MODEL_VALUE; console.log(JSON.stringify(m));')"
          fi
        done <<EOF
${output}
EOF
        updated_json="$(ccq_provider_set_model_env_json "${profile_path}" "${editable_json}")" || return 1
        ccq_json_write_atomic "${profile_path}" "${updated_json}" || return 1
        was_active=0
        [ "${key}" = "$(ccq_provider_resolve_active_key)" ] && was_active=1
        [ "${was_active}" = "1" ] && ccq_provider_switch_profile "${profile_path}" >/dev/null 2>&1 || true
        ccq_ui_success "模型配置已保存"
        ;;
      1)
        if [ "${editable_json}" = "{}" ]; then
          ccq_ui_dim "当前无模型配置，无需清除"
          continue
        fi
        local confirm_idx
        confirm_idx="$(ccq_show_single_select_menu "确认清除全部模型配置？" 1 "是，清除" "否，取消")" || continue
        if [ "${confirm_idx}" = "0" ]; then
          editable_json="{}"
          updated_json="$(ccq_provider_set_model_env_json "${profile_path}" "${editable_json}")" || return 1
          ccq_json_write_atomic "${profile_path}" "${updated_json}" || return 1
          was_active=0
          [ "${key}" = "$(ccq_provider_resolve_active_key)" ] && was_active=1
          [ "${was_active}" = "1" ] && ccq_provider_switch_profile "${profile_path}" >/dev/null 2>&1 || true
          ccq_ui_success "已清除全部模型配置"
        fi
        ;;
      *) break ;;
    esac
  done
}

ccq_provider_edit_key() {
  local key="${1:-}"
  local profile_path choice new_value updated_json was_active pending_new_key effective_key target_path current_name current_base current_token model_summary
  ccq_provider_valid_key "${key}" || { CCQ_PROVIDER_ERROR="非法 Provider Key"; return 1; }
  profile_path="$(ccq_provider_profile_path "${key}")" || return 1
  [ -f "${profile_path}" ] || { CCQ_PROVIDER_ERROR="供应商 Profile 不存在"; return 1; }
  ccq_provider_tty || return 1

  current_name="$(ccq_provider_profile_field "${profile_path}" provider 2>/dev/null || true)"
  current_base="$(ccq_provider_profile_field "${profile_path}" baseUrl 2>/dev/null || true)"
  current_token="$(ccq_provider_profile_field "${profile_path}" authToken 2>/dev/null || true)"
  model_summary="$(ccq_provider_model_summary "${profile_path}")"
  printf '\n' >/dev/tty
  ccq_tty_write primary "当前配置:"
  ccq_tty_write info "  供应商: ${current_name:-${key}}"
  ccq_tty_write info "  Base URL: ${current_base:-'-'}"
  ccq_tty_write info "  API Key: $(ccq_mask_secret_value "${current_token}")"
  ccq_tty_write info "  模型配置: ${model_summary}"
  printf '\n' >/dev/tty

  choice="$(ccq_show_single_select_menu "编辑供应商 ${key} - 选择修改项" 0 "修改 API Key" "修改 Base URL" "修改供应商名称" "配置模型环境键" "全部重新配置")" || return 0
  case "${choice}" in
    0)
      new_value="$(ccq_provider_prompt_secret "新的 API Key（输入不会显示）")" || return 1
      [ -n "${new_value}" ] || { CCQ_PROVIDER_ERROR="API Key 不能为空"; return 1; }
      choice="api"
      ;;
    1)
      new_value="$(ccq_provider_prompt_text "新的 Base URL" "${current_base}")" || return 1
      case "${new_value}" in
        http://*|https://*) ;;
        *) CCQ_PROVIDER_ERROR="Base URL 必须以 http:// 或 https:// 开头"; return 1 ;;
      esac
      new_value="${new_value%/}"
      choice="base"
      ;;
    2)
      new_value="$(ccq_provider_prompt_text "新的供应商名称" "${current_name}")" || return 1
      [ -n "${new_value}" ] || { CCQ_PROVIDER_ERROR="名称不能为空"; return 1; }
      choice="name"
      ;;
    3)
      ccq_provider_edit_model_env "${key}"
      return $?
      ;;
    4)
      local backup_path add_result
      backup_path="${profile_path}.bak"
      cp "${profile_path}" "${backup_path}" || return 1
      if ccq_provider_interactive_install ask; then
        if [ "${CCQ_PROVIDER_LAST_KEY:-}" != "${key}" ] && [ -f "${profile_path}" ]; then
          rm -f "${profile_path}"
        fi
        rm -f "${backup_path}"
      else
        mv "${backup_path}" "${profile_path}" 2>/dev/null || true
        CCQ_PROVIDER_ERROR="${CCQ_PROVIDER_ERROR:-已取消，已恢复原有配置}"
        return 1
      fi
      return 0
      ;;
    *) CCQ_PROVIDER_ERROR="未知编辑选项"; return 1 ;;
  esac

  was_active=0
  [ "${key}" = "$(ccq_provider_resolve_active_key)" ] && was_active=1
  effective_key="${key}"
  pending_new_key=""
  if [ "${choice}" = "name" ]; then
    case "${key}" in
      custom-*)
        pending_new_key="$(ccq_provider_custom_key "${new_value}" "${current_base}" "${key}")"
        if [ -n "${pending_new_key}" ] && [ "${pending_new_key}" != "${key}" ]; then
          target_path="$(ccq_provider_profile_path "${pending_new_key}")" || pending_new_key=""
          if [ -n "${pending_new_key}" ] && [ -f "${target_path}" ]; then
            ccq_ui_warning "目标文件 ${pending_new_key}.json 已存在，仅更新显示名称"
            pending_new_key=""
          else
            effective_key="${pending_new_key}"
          fi
        fi
        ;;
    esac
  fi

  updated_json="$(CHOICE="${choice}" NEW_VALUE="${new_value}" NEW_KEY="${effective_key}" node -e '
const fs = require("fs");
const profile = JSON.parse(fs.readFileSync(process.argv[1], "utf8"));
if (!profile._meta || typeof profile._meta !== "object" || Array.isArray(profile._meta)) profile._meta = {};
if (!profile.env || typeof profile.env !== "object" || Array.isArray(profile.env)) profile.env = {};
if (process.env.CHOICE === "api") profile.env.ANTHROPIC_AUTH_TOKEN = process.env.NEW_VALUE;
if (process.env.CHOICE === "base") { profile._meta.baseUrl = process.env.NEW_VALUE; profile.env.ANTHROPIC_BASE_URL = process.env.NEW_VALUE; }
if (process.env.CHOICE === "name") profile._meta.provider = process.env.NEW_VALUE;
profile._meta.key = process.env.NEW_KEY || profile._meta.key;
profile._meta.configuredAt = profile._meta.configuredAt || new Date().toISOString();
profile._meta.updatedAt = new Date().toISOString();
process.stdout.write(JSON.stringify(profile, null, 2) + "\n");
' "${profile_path}")" || return 1
  new_value=""

  if [ -n "${pending_new_key}" ] && [ "${pending_new_key}" != "${key}" ]; then
    target_path="$(ccq_provider_profile_path "${pending_new_key}")" || return 1
    ccq_json_write_atomic "${target_path}" "${updated_json}" || return 1
    rm -f "${profile_path}"
    ccq_ui_success "供应商配置已更新: ${current_name:-${key}} (${key} → ${pending_new_key})"
  else
    ccq_json_write_atomic "${profile_path}" "${updated_json}" || return 1
    ccq_ui_success "供应商配置已更新: ${current_name:-${key}}"
  fi

  if [ "${was_active}" = "1" ]; then
    ccq_provider_switch_key "${effective_key}" >/dev/null || return 1
  fi
}

# ─── 交互安装流程（供 steps/ApiKey.zsh 与管理菜单复用）─────────────────────
# 成功: 设置 CCQ_PROVIDER_LAST_NAME / CCQ_PROVIDER_LAST_KEY，返回 0
# 失败: 设置 CCQ_PROVIDER_ERROR / CCQ_PROVIDER_LAST_BASEURL_OK，返回 1

ccq_provider_interactive_install() {
  local activate_mode="${1:-activate}"
  CCQ_PROVIDER_ERROR=""
  CCQ_PROVIDER_LAST_NAME=""
  CCQ_PROVIDER_LAST_KEY=""
  CCQ_PROVIDER_LAST_BASEURL_OK="false"
  CCQ_PROVIDER_LAST_ACTIVATED="false"

  local selected_key template_key provider_name base_url platform_url api_key model_env_json profile_json profile_path existing_lines action_idx overwrite_options=() overwrite_keys=()
  selected_key="$(ccq_provider_select_builtin)" || {
    CCQ_PROVIDER_ERROR="用户取消供应商选择"
    return 1
  }
  template_key="${selected_key}"
  provider_name="$(ccq_provider_get_builtin_field "${selected_key}" Name)"
  base_url="$(ccq_provider_get_builtin_field "${selected_key}" BaseUrl)"
  platform_url="$(ccq_provider_get_builtin_field "${selected_key}" PlatformUrl)"

  ccq_ui_success "已选择: ${provider_name}"

  if [ "${selected_key}" = "custom" ]; then
    ccq_provider_tty || { CCQ_PROVIDER_ERROR="无 TTY"; return 1; }
    printf '\n' >/dev/tty
    provider_name="$(ccq_provider_prompt_text "供应商名称（可选，直接回车使用默认）" "自定义供应商")"
    while true; do
      base_url="$(ccq_provider_prompt_text "Base URL（必填，如 https://api.example.com/anthropic）" "")"
      if [ -z "${base_url}" ]; then
        ccq_ui_danger "Base URL 不能为空" >/dev/tty
        continue
      fi
      case "${base_url}" in
        http://*|https://*) ;;
        *) ccq_ui_danger "Base URL 必须以 http:// 或 https:// 开头" >/dev/tty; continue ;;
      esac
      break
    done
    base_url="${base_url%/}"
    selected_key="$(ccq_provider_custom_key "${provider_name}" "${base_url}")"
    ccq_provider_valid_key "${selected_key}" || { CCQ_PROVIDER_ERROR="生成的 Provider Key 非法"; return 1; }
    ccq_ui_success "Base URL 已设置: ${base_url}"
  else
    ccq_ui_info "Base URL 已使用内置配置: ${base_url}"
    if [ -n "${platform_url}" ]; then
      ccq_ui_info "请前往以下平台获取 API Key: ${platform_url}"
    fi

    existing_lines="$(ccq_provider_builtin_profile_lines "${selected_key}" 2>/dev/null || true)"
    if [ -n "${existing_lines}" ]; then
      printf '\n' >/dev/tty
      ccq_ui_warning "检测到 ${provider_name} 已配置："
      while IFS= read -r line; do
        [ -n "${line}" ] || continue
        local item_key item_name item_url rest
        item_key="${line%%$'\t'*}"
        rest="${line#*$'\t'}"
        item_name="${rest%%$'\t'*}"
        item_url="${rest#*$'\t'}"
        ccq_ui_info "  - ${item_name} (${item_url}) [${item_key}]"
      done <<EOF
${existing_lines}
EOF
      action_idx="$(ccq_show_single_select_menu "如何处理？" 0 "新增（保留现有，创建新配置）" "覆盖现有配置" "取消添加")" || action_idx=2
      case "${action_idx}" in
        0)
          selected_key="$(ccq_provider_next_available_key "${selected_key}")"
          ccq_ui_primary "将创建新配置: ~/.claude/providers/${selected_key}.json"
          local new_display_name num_match
          new_display_name="$(ccq_provider_prompt_text "显示名称（可选，直接回车使用默认）" "")"
          if [ -n "${new_display_name}" ]; then
            provider_name="${new_display_name}"
          else
            num_match="${selected_key##*-}"
            ccq_provider_is_number "${num_match}" || num_match=2
            provider_name="${provider_name} (${num_match})"
          fi
          ;;
        1)
          overwrite_options=()
          overwrite_keys=()
          while IFS= read -r line; do
            [ -n "${line}" ] || continue
            local item_key item_name item_url rest
            item_key="${line%%$'\t'*}"
            rest="${line#*$'\t'}"
            item_name="${rest%%$'\t'*}"
            item_url="${rest#*$'\t'}"
            overwrite_keys+=("${item_key}")
            overwrite_options+=("${item_name} - ${item_url}")
          done <<EOF
${existing_lines}
EOF
          if [ "${#overwrite_keys[@]}" -eq 1 ]; then
            selected_key="${overwrite_keys[1]}"
          else
            local overwrite_idx
            overwrite_idx="$(ccq_show_single_select_menu "选择要覆盖的配置：" 0 "${overwrite_options[@]}")" || { CCQ_PROVIDER_ERROR="已取消"; return 1; }
            selected_key="${overwrite_keys[$((overwrite_idx + 1))]}"
          fi
          ;;
        *)
          CCQ_PROVIDER_ERROR="已取消，可通过修改供应商更新现有配置"
          return 1
          ;;
      esac
    fi
  fi

  if [ -z "${provider_name}" ] || [ -z "${base_url}" ]; then
    CCQ_PROVIDER_LAST_NAME="${provider_name}"
    CCQ_PROVIDER_ERROR="供应商名称或 Base URL 为空"
    return 1
  fi
  CCQ_PROVIDER_LAST_NAME="${provider_name}"
  CCQ_PROVIDER_LAST_KEY="${selected_key}"
  CCQ_PROVIDER_LAST_BASEURL_OK="true"

  profile_path="$(ccq_provider_profile_path "${selected_key}")" || { CCQ_PROVIDER_ERROR="Provider Key 非法"; return 1; }
  if [ "${template_key}" = "custom" ] && [ -f "${profile_path}" ]; then
    local exist_action
    printf '\n' >/dev/tty
    ccq_ui_warning "检测到同名供应商已存在: ~/.claude/providers/${selected_key}.json"
    exist_action="$(ccq_show_single_select_menu "如何处理？" 1 "覆盖现有配置" "取消添加")" || exist_action=1
    if [ "${exist_action}" != "0" ]; then
      CCQ_PROVIDER_ERROR="已取消，可通过修改供应商更新现有配置"
      return 1
    fi
  fi

  ccq_provider_tty || { CCQ_PROVIDER_ERROR="无 TTY"; return 1; }
  printf '\n' >/dev/tty
  ccq_ui_primary "请粘贴 ${provider_name} 的 API Key（输入不会回显）:" >/dev/tty
  ccq_ui_warning "注意: API Key 将写入 ~/.claude/settings.json 和 ~/.claude/providers/" >/dev/tty
  api_key="$(ccq_provider_prompt_secret "API Key")"
  if [ -z "${api_key}" ]; then
    CCQ_PROVIDER_ERROR="API Key 为空"
    return 1
  fi

  model_env_json="{}"
  if [ "${template_key}" = "custom" ] || ccq_provider_requires_model_config "${template_key}"; then
    local ask_index
    ask_index="$(ccq_show_single_select_menu "是否配置模型环境键？(可选，大多数供应商不需要)" 0 "跳过" "配置模型")" || ask_index=0
    if [ "${ask_index}" = "1" ]; then
      ccq_ui_primary "将写入 settings.env 的 3 个模型键；留空表示不设置该键" "essential"
      model_env_json="$(ccq_provider_read_model_env 2>/dev/null || printf '{}')"
    fi
  fi

  printf '\n' >/dev/tty
  ccq_ui_warning "即将写入以下配置："
  ccq_ui_info "  供应商: ${provider_name}"
  ccq_ui_info "  Base URL: ${base_url}"
  local extra_summary
  extra_summary="$(ccq_provider_builtin_extra_summary "${template_key}" 2>/dev/null || true)"
  [ -n "${extra_summary}" ] && ccq_ui_info "  额外 env: ${extra_summary}"
  ccq_ui_info "  Key 摘要: $(ccq_mask_secret_value "${api_key}")"
  printf '\n' >/dev/tty
  local confirm_index
  confirm_index="$(ccq_show_single_select_menu "确认保存配置？" 0 "是，保存" "否，取消")" || confirm_index=1
  if [ "${confirm_index}" != "0" ]; then
    api_key=""
    CCQ_PROVIDER_ERROR="已取消"
    return 1
  fi

  profile_json="$(ccq_provider_build_profile_json "${selected_key}" "${provider_name}" "${base_url}" "${api_key}" "${model_env_json}")" || {
    api_key=""
    CCQ_PROVIDER_ERROR="供应商 Profile 构建失败"
    return 1
  }
  api_key=""

  if ! ccq_json_write_atomic "${profile_path}" "${profile_json}"; then
    CCQ_PROVIDER_ERROR="供应商 Profile 写入失败"
    return 1
  fi
  ccq_ui_success "供应商 Profile 已保存: ~/.claude/providers/${selected_key}.json"

  case "${activate_mode}" in
    ask)
      local activate_index
      activate_index="$(ccq_show_single_select_menu "是否立即激活此供应商？" 0 "是，立即激活" "否，稍后激活")" || activate_index=1
      if [ "${activate_index}" = "0" ]; then
        ccq_provider_switch_profile "${profile_path}" || { CCQ_PROVIDER_ERROR="settings.json 激活供应商失败"; return 1; }
        CCQ_PROVIDER_LAST_ACTIVATED="true"
      fi
      ;;
    noactivate)
      ;;
    *)
      ccq_provider_switch_profile "${profile_path}" || { CCQ_PROVIDER_ERROR="settings.json 激活供应商失败"; return 1; }
      CCQ_PROVIDER_LAST_ACTIVATED="true"
      ;;
  esac

  ccq_provider_write_onboarding >/dev/null 2>&1 || true
  return 0
}

# ─── Dashboard ───────────────────────────────────────────────────────────────

ccq_provider_dashboard_fallback() {
  local lines rows=() count input idx op num key
  ccq_provider_tty || { ccq_provider_show_status; return 0; }
  while true; do
    lines="$(ccq_provider_display_lines 2>/dev/null || true)"
    rows=()
    [ -n "${lines}" ] && rows=( ${(f)lines} )
    count="${#rows[@]}"
    printf '\n' >/dev/tty
    ccq_tty_write primary "供应商管理"
    printf '\n' >/dev/tty
    if [ "${count}" -eq 0 ]; then
      ccq_tty_write warning "暂无供应商配置"
      printf '\n' >/dev/tty
      ccq_tty_write info "操作: A=添加供应商  Q=返回上级"
    else
      idx=1
      for row in "${rows[@]}"; do
        local row_key row_name row_url row_masked row_active row_path status_tag
        IFS=$'\t' read -r row_key row_name row_url row_masked row_active row_path <<< "${row}"
        status_tag="未启用"
        [ "${row_active}" = "true" ] && status_tag="已启用"
        printf '  [%s] %s - %s (%s)\n' "${idx}" "${row_name}" "${row_url}" "${status_tag}" >/dev/tty
        idx=$((idx + 1))
      done
      printf '\n' >/dev/tty
      ccq_tty_write info "操作: [编号]=切换活跃  A=添加  E<编号>=修改  M<编号>=模型配置  D<编号>=删除  Q=返回"
    fi
    printf '请输入: ' >/dev/tty
    IFS= read -r input </dev/tty || return 0
    input="${input//[[:space:]]/}"
    [ -n "${input}" ] || continue
    case "${input}" in
      q|Q) return 0 ;;
      a|A) ccq_provider_interactive_install ask || ccq_ui_warning "添加供应商失败: ${CCQ_PROVIDER_ERROR:-已取消}"; continue ;;
    esac
    if ccq_provider_is_number "${input}"; then
      idx=$((input - 1))
      if [ "${idx}" -ge 0 ] && [ "${idx}" -lt "${count}" ]; then
        IFS=$'\t' read -r key _rest <<< "${rows[$((idx + 1))]}"
        ccq_provider_switch_key "${key}" || ccq_ui_warning "切换失败"
      else
        ccq_ui_danger "编号超出范围"
      fi
      continue
    fi
    op="${input[1,1]}"
    num="${input[2,-1]}"
    if ! ccq_provider_is_number "${num}"; then
      ccq_ui_danger "无效输入"
      continue
    fi
    idx=$((num - 1))
    if [ "${idx}" -lt 0 ] || [ "${idx}" -ge "${count}" ]; then
      ccq_ui_danger "编号超出范围"
      continue
    fi
    IFS=$'\t' read -r key _rest <<< "${rows[$((idx + 1))]}"
    case "${op}" in
      e|E) ccq_provider_edit_key "${key}" || ccq_ui_warning "编辑失败: ${CCQ_PROVIDER_ERROR:-未知错误}" ;;
      m|M) ccq_provider_edit_model_env "${key}" || ccq_ui_warning "模型配置失败" ;;
      d|D) ccq_provider_remove_key "${key}" || ccq_ui_warning "删除失败: ${CCQ_PROVIDER_ERROR:-未知错误}" ;;
      *) ccq_ui_danger "无效输入" ;;
    esac
  done
}

ccq_provider_dashboard() {
  local selected_index=0 lines rows=() count key selected_row selected_name selected_path model_summary read_key
  ccq_provider_sync_from_settings

  if ! ccq_provider_tty; then
    ccq_provider_show_status
    return 0
  fi
  if ! ccq_detect_tty_ansi; then
    ccq_provider_dashboard_fallback
    return $?
  fi

  printf '\033[?25l' >/dev/tty
  trap 'printf "\033[?25h" >/dev/tty' INT TERM
  while true; do
    lines="$(ccq_provider_display_lines 2>/dev/null || true)"
    rows=()
    [ -n "${lines}" ] && rows=( ${(f)lines} )
    count="${#rows[@]}"
    if [ "${count}" -eq 0 ]; then
      selected_index=0
    else
      [ "${selected_index}" -ge "${count}" ] && selected_index=$((count - 1))
      [ "${selected_index}" -lt 0 ] && selected_index=0
    fi

    printf '\033[2J\033[H' >/dev/tty
    ccq_provider_show_dashboard_banner
    if [ "${count}" -eq 0 ]; then
      ccq_tty_write warning "  暂无供应商配置"
      printf '\n' >/dev/tty
      ccq_tty_write dim "  按 [A] 添加第一个供应商"
    else
      CCQ_PROVIDER_RENDER_TARGET=tty ccq_provider_render_table "${selected_index}" "${rows[@]}"
      selected_row="${rows[$((selected_index + 1))]}"
      IFS=$'\t' read -r key selected_name _base _masked _active selected_path <<< "${selected_row}"
      printf '\n' >/dev/tty
      model_summary="$(ccq_provider_model_summary "${selected_path}" 2>/dev/null || printf '读取失败')"
      ccq_tty_write dim "  模型配置: ${model_summary}"
    fi
    CCQ_PROVIDER_RENDER_TARGET=tty ccq_provider_render_action_bar "$([ "${count}" -gt 0 ] && printf '1' || printf '0')"

    read_key="$(ccq_provider_read_dashboard_key || printf 'escape')"
    case "${read_key}" in
      up)
        [ "${count}" -gt 0 ] && selected_index=$(((selected_index - 1 + count) % count))
        ;;
      down)
        [ "${count}" -gt 0 ] && selected_index=$(((selected_index + 1) % count))
        ;;
      enter)
        if [ "${count}" -gt 0 ]; then
          IFS=$'\t' read -r key _rest <<< "${rows[$((selected_index + 1))]}"
          printf '\033[?25h' >/dev/tty
          ccq_provider_switch_key "${key}" || ccq_provider_wait_key "切换失败，按任意键继续..."
          printf '\033[?25l' >/dev/tty
        fi
        ;;
      add)
        printf '\033[?25h' >/dev/tty
        ccq_provider_interactive_install ask || ccq_provider_wait_key "添加供应商失败: ${CCQ_PROVIDER_ERROR:-已取消}。按任意键继续..."
        printf '\033[?25l' >/dev/tty
        ;;
      edit)
        if [ "${count}" -gt 0 ]; then
          IFS=$'\t' read -r key _rest <<< "${rows[$((selected_index + 1))]}"
          printf '\033[?25h' >/dev/tty
          ccq_provider_edit_key "${key}" || ccq_provider_wait_key "编辑失败: ${CCQ_PROVIDER_ERROR:-未知错误}。按任意键继续..."
          printf '\033[?25l' >/dev/tty
        fi
        ;;
      model)
        if [ "${count}" -gt 0 ]; then
          IFS=$'\t' read -r key _rest <<< "${rows[$((selected_index + 1))]}"
          printf '\033[?25h' >/dev/tty
          ccq_provider_edit_model_env "${key}" || ccq_provider_wait_key "模型配置失败，按任意键继续..."
          printf '\033[?25l' >/dev/tty
        fi
        ;;
      delete)
        if [ "${count}" -gt 0 ]; then
          IFS=$'\t' read -r key selected_name _base _masked active_flag _path <<< "${rows[$((selected_index + 1))]}"
          printf '\033[?25h' >/dev/tty
          if [ "${active_flag}" = "true" ]; then
            ccq_ui_danger "无法删除当前活跃的供应商: ${selected_name}"
            ccq_ui_warning "请先切换到其他供应商后再删除"
            ccq_provider_wait_key
          else
            ccq_provider_remove_key "${key}" || ccq_provider_wait_key "删除失败: ${CCQ_PROVIDER_ERROR:-未知错误}。按任意键继续..."
          fi
          printf '\033[?25l' >/dev/tty
        fi
        ;;
      escape)
        printf '\033[?25h' >/dev/tty
        trap - INT TERM
        return 0
        ;;
    esac
  done
}

# ─── 交互管理菜单 ───────────────────────────────────────────────────────────

ccq_provider_manage_menu() {
  ccq_provider_dashboard
}
