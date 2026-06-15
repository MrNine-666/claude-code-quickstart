#!/bin/sh
# build.sh - macOS / Unix 本地单文件构建入口
# 功能: 从共享构建清单生成 macOS zsh 短 artifact

set -eu

usage() {
  cat <<'EOF'
Usage: sh installer/build.sh [OPTIONS]

Options:
  --platform <macos>  构建平台，默认 macos
  --output <dir>      输出目录，默认 repo 根目录 dist/
  --check             只检查 build.sh 语法/结构，不生成 artifact
  --help              显示帮助
EOF
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "${script_dir}/.." && pwd)
platform="macos"
output_dir="${repo_root}/dist"
check_only=0

check_build_script() {
  script_path="${script_dir}/build.sh"
  [ -f "${script_path}" ] || { printf '%s\n' "[FAIL] build.sh 不存在: ${script_path}" >&2; exit 1; }
  grep -q "^#!/bin/sh" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 #!/bin/sh shebang' >&2; exit 1; }
  grep -q "readJson('contracts/build.json')" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 未读取共享构建清单 contracts/build.json' >&2; exit 1; }
  grep -q "buildMacOSArtifact" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 macOS artifact 构建函数' >&2; exit 1; }
  grep -q "validateMacOSArtifact" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 macOS artifact 结构检查' >&2; exit 1; }
  grep -q "CCQ_SKILLS_CONTRACT" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 未声明 Skills contract 嵌入' >&2; exit 1; }
  grep -q "CCQ_UI_CONTRACT" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 未声明 UI contract 嵌入' >&2; exit 1; }

  if command -v zsh >/dev/null 2>&1; then
    zsh -n "${script_path}"
    printf '%s\n' '[PASS] build.sh zsh 语法检查通过'
  else
    printf '%s\n' '[INFO] 未检测到 zsh，已完成 build.sh 文本结构检查'
  fi
  printf '%s\n' '[PASS] build.sh 检查通过'
}

while [ "$#" -gt 0 ]; do
  case "$1" in
    --platform)
      [ "$#" -ge 2 ] || { printf '%s\n' '缺少 --platform 参数值' >&2; exit 2; }
      platform=$(printf '%s' "$2" | tr '[:upper:]' '[:lower:]')
      shift 2
      ;;
    --output)
      [ "$#" -ge 2 ] || { printf '%s\n' '缺少 --output 参数值' >&2; exit 2; }
      output_dir="$2"
      shift 2
      ;;
    --check)
      check_only=1
      shift
      ;;
    --help|-h)
      usage
      exit 0
      ;;
    *)
      printf '未知参数: %s\n' "$1" >&2
      usage >&2
      exit 2
      ;;
  esac
done

case "${platform}" in
  macos) ;;
  *)
    printf '无效平台: %s；build.sh 仅支持 macos\n' "${platform}" >&2
    usage >&2
    exit 2
    ;;
esac

if [ "${check_only}" -eq 1 ]; then
  check_build_script
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '缺少 node 命令，无法解析 installer/contracts/*.json 构建清单。' >&2
  exit 1
fi

node - "${script_dir}" "${output_dir}" "${platform}" <<'NODE_SCRIPT'
const fs = require('fs');
const path = require('path');
const childProcess = require('child_process');

const installerRoot = path.resolve(process.argv[2]);
const outputDir = path.resolve(process.argv[3]);
const platform = process.argv[4];

function fail(message) {
  console.error(`[FAIL] ${message}`);
  process.exit(1);
}

function pass(message) {
  console.log(`[PASS] ${message}`);
}

function info(message) {
  console.log(`[INFO] ${message}`);
}

function readText(filePath) {
  return fs.readFileSync(filePath, 'utf8');
}

function readJson(relativePath) {
  const fullPath = path.join(installerRoot, relativePath);
  if (!fs.existsSync(fullPath)) fail(`JSON 文件不存在: ${fullPath}`);
  return JSON.parse(readText(fullPath));
}

function requireFile(relativePath) {
  const fullPath = path.join(installerRoot, relativePath);
  if (!fs.existsSync(fullPath) || !fs.statSync(fullPath).isFile()) {
    fail(`源文件不存在: ${fullPath}`);
  }
  return fullPath;
}

function normalizeRelPath(value) {
  return String(value || '').replace(/\\/g, '/').replace(/^\.\//, '');
}

function macOSStepFiles(manifest, stepsContract) {
  const files = [];
  const common = manifest.MacOS.CommonStepFile;
  if (common && fs.existsSync(path.join(installerRoot, common))) files.push(normalizeRelPath(common));
  const steps = [...(stepsContract.Steps || [])].sort((a, b) => Number(a.Order || 0) - Number(b.Order || 0));
  for (const step of steps) {
    if (!step.MacOSStepFile) continue;
    const relPath = normalizeRelPath(step.MacOSStepFile);
    if (fs.existsSync(path.join(installerRoot, relPath))) files.push(relPath);
  }
  return files;
}

function artifactFor(manifest, role) {
  const artifact = ((manifest.MacOS || {}).Artifacts || []).find((item) => item.Role === role);
  if (!artifact) fail(`未找到构建 artifact 配置: MacOS/${role}`);
  return artifact;
}

function macOSBuildOrder(manifest, stepsContract, role) {
  const artifact = artifactFor(manifest, role);
  const order = [...(manifest.MacOS.CoreFiles || []).map(normalizeRelPath)];
  if (artifact.IncludeSteps) order.push(...macOSStepFiles(manifest, stepsContract));
  order.push(normalizeRelPath(artifact.EntryFile));
  return { artifact, order };
}

function contractEmbeds() {
  return [
    { file: 'steps.json', marker: 'CCQ_CONTRACT_STEPS_JSON', env: 'CCQ_STEPS_CONTRACT' },
    { file: 'providers.json', marker: 'CCQ_CONTRACT_PROVIDERS_JSON', env: 'CCQ_PROVIDER_CONTRACT' },
    { file: 'mcp-servers.json', marker: 'CCQ_CONTRACT_MCP_SERVERS_JSON', env: 'CCQ_MCP_CONTRACT' },
    { file: 'claude-config.json', marker: 'CCQ_CONTRACT_CLAUDE_CONFIG_JSON', env: 'CCQ_CLAUDE_CONFIG_CONTRACT' },
    { file: 'skills.json', marker: 'CCQ_CONTRACT_SKILLS_JSON', env: 'CCQ_SKILLS_CONTRACT' },
    { file: 'ui.json', marker: 'CCQ_CONTRACT_UI_JSON', env: 'CCQ_UI_CONTRACT' },
    { file: 'scripts/claude-config-drift.js', marker: 'CCQ_SCRIPT_CLAUDE_CONFIG_DRIFT_JS', env: null },
    { file: 'scripts/skills-discovery.js', marker: 'CCQ_SCRIPT_SKILLS_DISCOVERY_JS', env: null },
  ];
}

function appendMacOSWrapper(lines) {
  lines.push('#!/usr/bin/env bash');
  lines.push('set +x 2>/dev/null || true');
  lines.push('# ═══════════════════════════════════════════════════════════════════════════════');
  lines.push('# 本文件由 build.sh 自动生成，请勿手动编辑');
  lines.push(`# 生成时间: ${new Date().toISOString()}`);
  lines.push('# ═══════════════════════════════════════════════════════════════════════════════');
  lines.push('if [ -z "${ZSH_VERSION:-}" ]; then');
  lines.push('  if [ -x "/bin/zsh" ]; then');
  lines.push('    if [ -n "${BASH_SOURCE[0]:-}" ] && [ -f "${BASH_SOURCE[0]}" ]; then');
  lines.push('      exec /bin/zsh "${BASH_SOURCE[0]}" "$@"');
  lines.push('    fi');
  lines.push('    ccq_streamed_script="$(mktemp "${TMPDIR:-/tmp}/ccq-built.XXXXXX")" || exit 1');
  lines.push('    cat > "${ccq_streamed_script}"');
  lines.push('    export CCQ_STREAMED_SCRIPT_PATH="${ccq_streamed_script}"');
  lines.push('    exec /bin/zsh "${ccq_streamed_script}" "$@"');
  lines.push('  fi');
  lines.push("  printf '%s\\n' 'CCQ macOS built script requires /bin/zsh.' >&2");
  lines.push('  exit 1');
  lines.push('fi');
  lines.push('export CCQ_BUILT_MODE=1');
  lines.push('ccq_cleanup_built_artifacts() {');
  lines.push('  if [ -n "${CCQ_STREAMED_SCRIPT_PATH:-}" ]; then rm -f "${CCQ_STREAMED_SCRIPT_PATH}"; fi');
  lines.push('  if [ -n "${CCQ_BUILT_CONTRACTS_DIR:-}" ]; then rm -rf "${CCQ_BUILT_CONTRACTS_DIR}"; fi');
  lines.push('}');
  lines.push('trap ccq_cleanup_built_artifacts EXIT');
  lines.push('CCQ_BUILT_CONTRACTS_DIR="$(mktemp -d "${TMPDIR:-/tmp}/ccq-contracts.XXXXXX")" || exit 1');
  lines.push('export CCQ_BUILT_CONTRACTS_DIR');
  lines.push('export CCQ_CONTRACTS_DIR="${CCQ_BUILT_CONTRACTS_DIR}"');

  // 导出环境变量（仅针对有 env 字段的契约）
  for (const contract of contractEmbeds()) {
    if (contract.env) {
      lines.push(`export ${contract.env}="\${CCQ_BUILT_CONTRACTS_DIR}/${contract.file}"`);
    }
  }

  // 嵌入所有契约和脚本文件
  for (const contract of contractEmbeds()) {
    const contractPath = path.join(installerRoot, 'contracts', contract.file);
    if (!fs.existsSync(contractPath)) fail(`契约文件不存在，无法生成自包含 macOS artifact: ${contractPath}`);

    // 确保目标目录存在（处理 scripts/ 子目录）
    const targetDir = path.dirname(contract.file);
    if (targetDir !== '.') {
      lines.push(`mkdir -p "\${CCQ_BUILT_CONTRACTS_DIR}/${targetDir}"`);
    }

    lines.push(`cat > "\${CCQ_BUILT_CONTRACTS_DIR}/${contract.file}" <<'${contract.marker}'`);
    lines.push(readText(contractPath).replace(/[\r\n]+$/g, ''));
    lines.push(contract.marker);
  }
  lines.push('');
}

function filterZshSource(relativePath) {
  const sourceLines = readText(requireFile(relativePath)).split(/\r?\n/);
  const lines = [];
  let skipUntilSetOpt = false;
  let skipStreamedTrapBlock = false;

  for (const line of sourceLines) {
    if (/^\s*#!/.test(line)) continue;
    if (/^\s*if \[ -z "\$\{ZSH_VERSION:-\}" \]; then\s*$/.test(line)) {
      skipUntilSetOpt = true;
      continue;
    }
    if (skipUntilSetOpt) {
      if (/^\s*setopt\s+/.test(line)) skipUntilSetOpt = false;
      else continue;
    }
    if (/^\s*if \[ -n "\$\{CCQ_STREAMED_SCRIPT_PATH:-\}" \]; then\s*$/.test(line)) {
      skipStreamedTrapBlock = true;
      continue;
    }
    if (skipStreamedTrapBlock) {
      if (/^\s*fi\s*$/.test(line)) skipStreamedTrapBlock = false;
      continue;
    }
    const trimmed = line.trim();
    if (trimmed === 'source "${file_path}"' || trimmed === 'source "${full_path}"') continue;
    if (/^\s*ccq_main "\$@"\s*$/.test(line)) continue;
    if (/^\s*ccq_manage_main "\$@"\s*$/.test(line)) continue;
    lines.push(line);
  }

  return lines;
}

function getMcpManagerBase64() {
  const jsPath = path.join(installerRoot, 'contracts', 'scripts', 'mcp-manager.js');
  if (!fs.existsSync(jsPath)) {
    console.warn('[WARN] mcp-manager.js 不存在，跳过内嵌');
    return null;
  }
  try {
    const buffer = fs.readFileSync(jsPath);
    return buffer.toString('base64');
  } catch (err) {
    console.warn(`[WARN] 无法读取或编码 mcp-manager.js: ${err.message}`);
    return null;
  }
}

function getManageScriptsBase64() {
  // 读取 manage.js 及其子管理器，编码为 base64 JSON
  // 返回格式: {"manage.js":"<base64>","provider-manager.js":"<base64>",...}
  const scriptsDir = path.join(installerRoot, 'contracts', 'scripts');
  const targets = ['manage.js', 'provider-manager.js', 'skills-manager.js', 'update-manager.js'];
  const result = {};
  for (const fileName of targets) {
    const filePath = path.join(scriptsDir, fileName);
    if (!fs.existsSync(filePath)) {
      console.warn(`[WARN] ${fileName} 不存在，跳过内嵌`);
      continue;
    }
    try {
      const buffer = fs.readFileSync(filePath);
      result[fileName] = buffer.toString('base64');
    } catch (err) {
      console.warn(`[WARN] 无法读取或编码 ${fileName}: ${err.message}`);
    }
  }
  return Object.keys(result).length > 0 ? JSON.stringify(result) : null;
}

function buildMacOSArtifact(manifest, stepsContract, role, mcpManagerBase64, manageScriptsBase64) {
  const { artifact, order } = macOSBuildOrder(manifest, stepsContract, role);
  for (const relPath of order) requireFile(relPath);

  const outputPath = path.join(outputDir, artifact.OutputFile);
  const lines = [];
  appendMacOSWrapper(lines);
  lines.push('# 原始文件:');
  for (const relPath of order) lines.push(`#   - ${relPath}`);

  for (const relPath of order) {
    lines.push('');
    lines.push(`# ─── 来自: ${relPath} ────────────────────────────────────────`);
    lines.push('');
    lines.push(...filterZshSource(relPath));

    // 注入 MCP Manager JS 脚本 base64（仅对 McpManager.zsh）
    if (mcpManagerBase64 && relPath.includes('McpManager.zsh')) {
      lines.push('');
      lines.push('# ─── MCP Manager JS 脚本内嵌（构建时注入）───');
      lines.push(`CCQ_MCP_MANAGER_B64="${mcpManagerBase64}"`);
      lines.push('');
    }

    // 注入 manage.js 及子管理器 base64（仅对 macos/Manage.zsh 入口文件）
    if (manageScriptsBase64 && relPath.includes('macos/Manage.zsh')) {
      lines.push('');
      lines.push('# ─── manage.js + 子管理器 JS 脚本内嵌（构建时注入）───');
      lines.push(`CCQ_MANAGE_SCRIPTS_JSON='${manageScriptsBase64}'`);
      lines.push('');
    }
  }

  const entryFile = order[order.length - 1] || '';
  lines.push('');
  if (/macos\/Install\.zsh$/.test(entryFile)) lines.push('ccq_main "$@"');
  else if (/macos\/Manage\.zsh$/.test(entryFile)) lines.push('ccq_manage_main "$@"');
  else fail(`无法识别 macOS artifact 入口文件: ${entryFile}`);

  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, `${lines.join('\n')}`, 'utf8');
  fs.chmodSync(outputPath, 0o755);
  pass(`已生成: ${outputPath}`);
  validateMacOSArtifact(outputPath);
  return outputPath;
}

function validateMacOSArtifact(outputPath) {
  const content = readText(outputPath);
  if (!content.startsWith('#!/usr/bin/env bash')) fail(`${path.basename(outputPath)} 缺少 bash wrapper shebang`);
  if (!content.includes('export CCQ_BUILT_MODE=1')) fail(`${path.basename(outputPath)} 缺少 CCQ_BUILT_MODE`);
  if (!content.includes('CCQ_CONTRACT_STEPS_JSON')) fail(`${path.basename(outputPath)} 未嵌入 steps contract`);
  if (!content.includes('CCQ_CONTRACT_SKILLS_JSON')) fail(`${path.basename(outputPath)} 未嵌入 skills contract`);
  if (!content.includes('CCQ_CONTRACT_UI_JSON')) fail(`${path.basename(outputPath)} 未嵌入 ui contract`);
  const forbiddenSourceLines = content.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed === 'source "${file_path}"' || trimmed === 'source "${full_path}"'
      || trimmed === '. "${file_path}"' || trimmed === '. "${full_path}"';
  });
  if (forbiddenSourceLines.length > 0) fail(`${path.basename(outputPath)} 仍包含入口模块加载 source 行`);

  const zsh = childProcess.spawnSync('zsh', ['-n', outputPath], { encoding: 'utf8' });
  if (zsh.error && zsh.error.code === 'ENOENT') {
    info(`未检测到 zsh，跳过 zsh -n 检查: ${path.basename(outputPath)}`);
    return;
  }
  if (zsh.status !== 0) fail(`zsh 语法检查失败: ${path.basename(outputPath)}\n${zsh.stderr || zsh.stdout}`);
  pass(`zsh 语法检查通过: ${outputPath}`);
}

function clearKnownBuildArtifacts() {
  // macOS 构建入口只清理 macOS 产物（.sh），保留 Windows 产物（.ps1）
  for (const fileName of ['install.sh', 'manage.sh']) {
    const fullPath = path.join(outputDir, fileName);
    if (fs.existsSync(fullPath)) fs.rmSync(fullPath, { force: true });
  }
}

function ensureExpectedOutputs(manifest) {
  const expected = manifest.MacOS.Artifacts.map((item) => item.OutputFile);
  for (const fileName of expected) {
    const fullPath = path.join(outputDir, fileName);
    if (!fs.existsSync(fullPath)) fail(`缺少预期输出文件: ${fullPath}`);
  }
  // 注释：不再禁止 Windows 产物存在，允许两个平台产物共存
  pass(`输出文件集合检查通过: ${expected.join(', ')}`);
}

const manifest = readJson('contracts/build.json');
const stepsContract = readJson(manifest.MacOS.StepContract || 'contracts/steps.json');
fs.mkdirSync(outputDir, { recursive: true });
clearKnownBuildArtifacts();

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Claude Code 安装器 - macOS 单文件构建工具');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`安装器根目录: ${installerRoot}`);
console.log(`输出目录:     ${outputDir}`);
console.log(`构建平台:     ${platform}`);

// 生成 MCP Manager JS 脚本 base64（供 Install 和 Manage 内嵌）
console.log('');
console.log('─── 处理 MCP Manager JS 脚本 ───────────────────────────────');
const mcpManagerBase64 = getMcpManagerBase64();
if (mcpManagerBase64) {
  console.log(`[PASS] MCP Manager JS 脚本已编码（base64 长度: ${mcpManagerBase64.length}）`);
} else {
  console.log('[WARN] MCP Manager JS 脚本未编码，Release 模式将依赖源码模式部署');
}

// 生成 macOS Manage JS 脚本集合 base64（供 Manage 内嵌）
console.log('');
console.log('─── 处理 macOS Manage JS 脚本集合 ───────────────────────');
const manageScriptsBase64 = getManageScriptsBase64();
if (manageScriptsBase64) {
  const count = JSON.parse(manageScriptsBase64);
  console.log(`[PASS] macOS Manage JS 脚本集合已编码（文件数: ${Object.keys(count).length}）`);
} else {
  console.log('[WARN] macOS Manage JS 脚本集合为空，Release 模式将依赖源码模式部署');
}
console.log('');

buildMacOSArtifact(manifest, stepsContract, 'Install', mcpManagerBase64, null);
buildMacOSArtifact(manifest, stepsContract, 'Manage', mcpManagerBase64, manageScriptsBase64);

ensureExpectedOutputs(manifest);
console.log('');
console.log('[PASS] macOS 构建完成');
NODE_SCRIPT
