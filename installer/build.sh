#!/bin/sh
# build.sh - Unix（macOS / Linux）本地单文件构建入口
# 功能: 从共享构建清单生成 Unix dispatcher（install.sh / download-tui.sh，内嵌 macOS zsh 与
#       Linux Bash 两个 payload）与 macOS 专用 download-tui.zsh

set -eu

usage() {
  cat <<'EOF'
Usage: sh installer/build.sh [OPTIONS]

Options:
  --platform <unix>    构建平台，默认 unix（macos 为兼容别名，同样生成全部 Unix 脚本）
  --output <dir>       输出目录，默认 repo 根目录 dist/
  --scripts-only       只生成脚本（默认），不编译或检查 TUI 可执行文件
  --skip-tui-build     兼容旧调用，等同 --scripts-only
  --check              只检查 build.sh 语法/结构，不生成 artifact
  --help               显示帮助
EOF
}

script_dir=$(CDPATH= cd -- "$(dirname -- "$0")" && pwd)
repo_root=$(CDPATH= cd -- "${script_dir}/.." && pwd)
platform="unix"
output_dir="${repo_root}/dist"
check_only=0

check_build_script() {
  script_path="${script_dir}/build.sh"
  gzip_probe_path="${script_dir}/contracts/Test-MacOSGzipTransport.zsh"
  [ -f "${script_path}" ] || { printf '%s\n' "[FAIL] build.sh 不存在: ${script_path}" >&2; exit 1; }
  [ -f "${gzip_probe_path}" ] || { printf '%s\n' "[FAIL] macOS gzip transport probe 不存在: ${gzip_probe_path}" >&2; exit 1; }
  grep -q "^#!/bin/sh" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 #!/bin/sh shebang' >&2; exit 1; }
  grep -q "readJson('installer/contracts/build.json')" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 未读取共享构建清单 installer/contracts/build.json' >&2; exit 1; }
  grep -q "buildMacOSArtifact" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 macOS artifact 构建函数' >&2; exit 1; }
  grep -q "validateMacOSArtifact" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 macOS artifact 结构检查' >&2; exit 1; }
  grep -q "buildLinuxPayload" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 Linux payload 构建函数' >&2; exit 1; }
  grep -q "validateLinuxPayload" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 Linux payload 结构检查' >&2; exit 1; }
  grep -q "buildUnixDispatcher" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 Unix dispatcher 构建函数' >&2; exit 1; }
  grep -q "validateUnixDispatcher" "${script_path}" || { printf '%s\n' '[FAIL] build.sh 缺少 Unix dispatcher 结构检查' >&2; exit 1; }

  if command -v zsh >/dev/null 2>&1; then
    zsh -n "${script_path}"
    printf '%s\n' '[PASS] build.sh zsh 语法检查通过'
    zsh -n "${gzip_probe_path}"
    zsh "${gzip_probe_path}"
  else
    printf '%s\n' '[INFO] 未检测到 zsh，跳过 macOS gzip transport behavior probe'
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
    --scripts-only|--skip-tui-build)
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

# install.sh / download-tui.sh 同时内嵌 macOS 与 Linux payload，不存在只构建单一 Unix 平台的产物；
# 旧调用 --platform macos 继续可用，行为等同 unix。
case "${platform}" in
  unix|macos) platform="unix" ;;
  *)
    printf '无效平台: %s；build.sh 仅支持 unix（兼容别名 macos）\n' "${platform}" >&2
    usage >&2
    exit 2
    ;;
esac

if [ "${check_only}" -eq 1 ]; then
  check_build_script
  exit 0
fi

if ! command -v node >/dev/null 2>&1; then
  printf '%s\n' '缺少 node 命令，无法解析 contracts/*.json 构建清单。' >&2
  exit 1
fi

node - "${script_dir}" "${output_dir}" "${platform}" <<'NODE_SCRIPT'
const fs = require('fs');
const os = require('os');
const path = require('path');
const crypto = require('crypto');
const childProcess = require('child_process');

const installerRoot = path.resolve(process.argv[2]);
const outputDir = path.resolve(process.argv[3]);
const platform = process.argv[4];
// 清单与内嵌契约从 repo 根目录定位。
const repoRoot = path.dirname(installerRoot);

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
  const fullPath = path.join(repoRoot, relativePath);
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

function linuxStepFiles(stepsContract) {
  return [...(stepsContract.Steps || [])]
    .sort((a, b) => Number(a.Order || 0) - Number(b.Order || 0))
    .filter((step) => step.LinuxStepFile)
    .map((step) => normalizeRelPath(step.LinuxStepFile));
}

function artifactFor(manifest, platformKey, role) {
  const artifact = ((manifest[platformKey] || {}).Artifacts || []).find((item) => item.Role === role);
  if (!artifact) fail(`未找到构建 artifact 配置: ${platformKey}/${role}`);
  return artifact;
}

// 同平台各 role 加载同一套 core（只有 step 模块不同），因此 CoreFiles 只在 Install role
// 声明一次；声明了 ReuseCoreFilesFromRole 的 role 直接复用，避免同一份名单在 build.json 里
// 出现两份而漂移。installer/contracts/Test-Contracts.ps1 断言同样的回退语义。
function coreFilesFor(manifest, platformKey, artifact) {
  if (Array.isArray(artifact.CoreFiles)) return artifact.CoreFiles;
  const sourceRole = artifact.ReuseCoreFilesFromRole;
  if (!sourceRole) fail(`artifact ${artifact.Role} 既未声明 CoreFiles 也未声明 ReuseCoreFilesFromRole`);
  const source = artifactFor(manifest, platformKey, sourceRole);
  if (!Array.isArray(source.CoreFiles) || source.CoreFiles.length === 0) {
    fail(`artifact ${artifact.Role} 复用的 ${sourceRole}.CoreFiles 为空`);
  }
  return source.CoreFiles;
}

function payloadBuildOrder(manifest, stepsContract, platformKey, role) {
  const artifact = artifactFor(manifest, platformKey, role);
  const order = [...coreFilesFor(manifest, platformKey, artifact).map(normalizeRelPath)];
  if (artifact.IncludeSteps) {
    order.push(...(platformKey === 'Linux' ? linuxStepFiles(stepsContract) : macOSStepFiles(manifest, stepsContract)));
  }
  order.push(normalizeRelPath(artifact.EntryFile));
  return { artifact, order };
}

function contractEmbeds(manifest, role) {
  // role-aware：install artifact 需要安装链 steps 契约；CcqDownload 不执行 step，
  // 不嵌 steps 契约，避免给不执行 step 的入口制造无用依赖。
  // TUI 契约由 ccq 可执行文件内嵌；Linux payload 不嵌入任何契约。
  const artifact = artifactFor(manifest, 'MacOS', role);
  if (!artifact.IncludeSteps) return [];
  return [
    { file: 'steps.json', sourceDir: 'installer/contracts', marker: 'CCQ_CONTRACT_STEPS_JSON', env: 'CCQ_STEPS_CONTRACT' },
  ];
}

function appendMacOSWrapper(lines, embeds) {
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
  for (const contract of embeds) {
    if (contract.env) {
      lines.push(`export ${contract.env}="\${CCQ_BUILT_CONTRACTS_DIR}/${contract.file}"`);
    }
  }

  // 嵌入所有契约和脚本文件（每项经 sourceDir 定位拆分后的契约目录）
  for (const contract of embeds) {
    const contractPath = path.join(repoRoot, contract.sourceDir, contract.file);
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
    // 入口只 source Load.zsh；built artifact 已内联 Load.zsh，必须去掉该行。
    if (trimmed === 'source "${CCQ_MACOS_ROOT}/core/Load.zsh"') continue;
    if (/^\s*ccq_(?:main|download_main) "\$@"\s*$/.test(line)) continue;
    lines.push(line);
  }

  return lines;
}

const entryCalls = {
  Install: 'ccq_main "$@"',
  CcqDownload: 'ccq_download_main "$@"',
};

function entryCallFor(platformKey, role) {
  const entryCall = entryCalls[role];
  if (!entryCall) fail(`无法识别 ${platformKey} artifact role: ${role}`);
  return entryCall;
}

function renderMacOSPayload(manifest, stepsContract, role) {
  const { artifact, order } = payloadBuildOrder(manifest, stepsContract, 'MacOS', role);
  for (const relPath of order) requireFile(relPath);

  const lines = [];
  appendMacOSWrapper(lines, contractEmbeds(manifest, role));
  lines.push('# 原始文件:');
  for (const relPath of order) lines.push(`#   - ${relPath}`);

  for (const relPath of order) {
    lines.push('');
    lines.push(`# ─── 来自: ${relPath} ────────────────────────────────────────`);
    lines.push('');
    lines.push(...filterZshSource(relPath));
  }

  const content = lines.join('\n');
  const finalLines = [content, '', entryCallFor('MacOS', role)];
  return { artifact, content: finalLines.join('\n') };
}

function buildMacOSArtifact(manifest, stepsContract, role) {
  const { artifact, content } = renderMacOSPayload(manifest, stepsContract, role);
  const outputPath = path.join(outputDir, artifact.OutputFile);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, content, 'utf8');
  fs.chmodSync(outputPath, 0o755);
  pass(`已生成: ${outputPath}`);
  validateMacOSArtifact(artifact.OutputFile, content, artifact);
  return outputPath;
}

// 用临时文件做 `<shell> -n`；缺少解释器时只提示跳过。
function syntaxCheck(shell, label, content) {
  const tempDir = fs.mkdtempSync(path.join(os.tmpdir(), 'ccq-build-syntax-'));
  try {
    const tempFile = path.join(tempDir, 'payload');
    fs.writeFileSync(tempFile, content, 'utf8');
    const result = childProcess.spawnSync(shell, ['-n', tempFile], { encoding: 'utf8' });
    if (result.error && result.error.code === 'ENOENT') {
      info(`未检测到 ${shell}，跳过 ${shell} -n 检查: ${label}`);
      return;
    }
    if (result.status !== 0) fail(`${shell} 语法检查失败: ${label}\n${result.stderr || result.stdout}`);
    pass(`${shell} 语法检查通过: ${label}`);
  } finally {
    fs.rmSync(tempDir, { recursive: true, force: true });
  }
}

// payload 运行时只能依赖自身内容：不得残留构建机路径或按源码目录 source 模块。
function assertNoRepoPathDependency(label, content) {
  for (const root of [repoRoot, repoRoot.replace(/\\/g, '/')]) {
    if (content.includes(root)) fail(`${label} 含构建机仓库路径: ${root}`);
  }
  if (/^\s*(?:source|\.)\s+"\$\{CCQ_(?:LINUX|MACOS|INSTALLER)_ROOT\}/m.test(content)) {
    fail(`${label} 仍按源码目录 source 模块`);
  }
}

function validateMacOSArtifact(label, content, artifact) {
  if (!content.startsWith('#!/usr/bin/env bash')) fail(`${label} 缺少 bash wrapper shebang`);
  if (!content.includes('export CCQ_BUILT_MODE=1')) fail(`${label} 缺少 CCQ_BUILT_MODE`);
  if (artifact.IncludeSteps && !content.includes('CCQ_CONTRACT_STEPS_JSON')) {
    fail(`${label} 未嵌入 steps contract`);
  }
  if (!artifact.IncludeSteps && content.includes('CCQ_CONTRACT_STEPS_JSON')) {
    fail(`${label} 不应嵌入 steps contract`);
  }
  const forbiddenSourceLines = content.split(/\r?\n/).filter((line) => {
    const trimmed = line.trim();
    return trimmed === 'source "${file_path}"' || trimmed === 'source "${full_path}"'
      || trimmed === '. "${file_path}"' || trimmed === '. "${full_path}"'
      || trimmed === 'source "${CCQ_MACOS_ROOT}/core/Load.zsh"';
  });
  if (forbiddenSourceLines.length > 0) fail(`${label} 仍包含入口模块加载 source 行`);
  assertNoRepoPathDependency(label, content);
  syntaxCheck('zsh', label, content);
}

// Linux 内联剥离：入口加载 Load.sh、source 模式逐个加载 core/step 的行，以及入口调用（末尾统一追加一次）。
const linuxStrippedLines = new Set([
  'source "${CCQ_LINUX_ROOT}/core/Load.sh"',
  'source "${file_path}"',
  'source "${full_path}"',
  'ccq_main "$@"',
  'ccq_download_main "$@"',
]);

function filterBashSource(relativePath) {
  return readText(requireFile(relativePath)).split(/\r?\n/)
    .filter((line) => !/^\s*#!/.test(line) && !linuxStrippedLines.has(line.trim()));
}

function buildLinuxPayload(manifest, stepsContract, role) {
  const { order } = payloadBuildOrder(manifest, stepsContract, 'Linux', role);
  for (const relPath of order) requireFile(relPath);

  const lines = ['export CCQ_BUILT_MODE=1', '# 原始文件:'];
  for (const relPath of order) lines.push(`#   - ${relPath}`);
  for (const relPath of order) {
    lines.push('');
    lines.push(`# ─── 来自: ${relPath} ────────────────────────────────────────`);
    lines.push('');
    lines.push(...filterBashSource(relPath));
  }
  lines.push('', entryCallFor('Linux', role));
  const content = lines.join('\n');
  validateLinuxPayload(`Linux ${role} payload`, content, role);
  return content;
}

function validateLinuxPayload(label, content, role) {
  if (!content.startsWith('export CCQ_BUILT_MODE=1\n')) fail(`${label} 必须以 export CCQ_BUILT_MODE=1 开头`);
  const lines = content.split('\n');
  const strippedLeft = lines.filter((line) => linuxStrippedLines.has(line.trim()));
  if (strippedLeft.length !== 1 || lines[lines.length - 1] !== entryCallFor('Linux', role)) {
    fail(`${label} 仍包含 source 加载行，或入口调用不是唯一的末行`);
  }
  if (lines.some((line) => /^\s*#!/.test(line))) fail(`${label} 不应包含 shebang 行`);
  if (!content.includes('if [ -n "${CCQ_STREAMED_SCRIPT_PATH:-}" ]; then')) fail(`${label} 缺少临时 payload 清理 trap`);
  if (!content.includes('__CCQ_RELEASE_TAG__')) fail(`${label} 缺少 __CCQ_RELEASE_TAG__ 占位`);
  if (content.includes('CCQ_CONTRACT_')) fail(`${label} 不应嵌入契约`);
  assertNoRepoPathDependency(label, content);
  syntaxCheck('bash', label, content);
}

// 带引号 heredoc 让 dispatcher 所在 shell 不解析 payload；marker 后缀取内容哈希（忽略生成时间），
// 同一份源码重复构建得到相同 marker。
function payloadMarkerSuffix(payloads) {
  const stable = payloads.map((payload) => payload.replace(/^# 生成时间: .*$/m, '')).join('\0');
  return crypto.createHash('sha256').update(stable).digest('hex').slice(0, 12);
}

function buildUnixDispatcher(manifest, stepsContract, unixArtifact) {
  const role = unixArtifact.Role;
  const macPayload = renderMacOSPayload(manifest, stepsContract, role);
  validateMacOSArtifact(`macOS ${role} payload`, macPayload.content, macPayload.artifact);
  const linuxPayload = buildLinuxPayload(manifest, stepsContract, role);

  const suffix = payloadMarkerSuffix([macPayload.content, linuxPayload]);
  const markers = { macOS: `CCQ_MACOS_PAYLOAD_${suffix}`, linux: `CCQ_LINUX_PAYLOAD_${suffix}` };
  for (const marker of Object.values(markers)) {
    if (macPayload.content.includes(marker) || linuxPayload.includes(marker)) fail(`heredoc marker 与 payload 内容冲突: ${marker}`);
  }

  const lines = [
    '#!/bin/sh',
    '# ═══════════════════════════════════════════════════════════════════════════════',
    '# 本文件由 build.sh 自动生成，请勿手动编辑',
    `# 生成时间: ${new Date().toISOString()}`,
    '# Unix 入口: 按 uname -s 把 macOS zsh 或 Linux Bash payload 写入临时文件，再交给对应解释器执行。',
    '# 未选中平台的 payload 位于带引号 heredoc 内，不会被当前 shell 解析。',
    '# ═══════════════════════════════════════════════════════════════════════════════',
    'ccq_payload="$(mktemp "${TMPDIR:-/tmp}/ccq-built.XXXXXX")" || exit 1',
    'ccq_os="$(uname -s 2>/dev/null)"',
    'case "${ccq_os}" in',
    '  Darwin)',
    '    ccq_interp=/bin/zsh',
    `    cat > "\${ccq_payload}" <<'${markers.macOS}' || { rm -f "\${ccq_payload}"; exit 1; }`,
    macPayload.content,
    markers.macOS,
    '    ;;',
    '  Linux)',
    '    ccq_interp="$(command -v bash 2>/dev/null || true)"',
    `    cat > "\${ccq_payload}" <<'${markers.linux}' || { rm -f "\${ccq_payload}"; exit 1; }`,
    linuxPayload,
    markers.linux,
    '    ;;',
    '  *)',
    '    rm -f "${ccq_payload}"',
    "    printf '不支持的平台: %s；本脚本仅支持 macOS 与 Linux，Windows 请使用 install.ps1 / download-tui.ps1\\n' \"${ccq_os:-unknown}\" >&2",
    '    exit 1',
    '    ;;',
    'esac',
    'if [ -z "${ccq_interp}" ] || [ ! -x "${ccq_interp}" ]; then',
    '  rm -f "${ccq_payload}"',
    "  printf '缺少解释器: %s 需要 %s\\n' \"${ccq_os}\" \"${ccq_interp:-bash}\" >&2",
    '  exit 1',
    'fi',
    '# payload 内的 CCQ_STREAMED_SCRIPT_PATH trap 负责退出时删除临时文件。',
    'export CCQ_STREAMED_SCRIPT_PATH="${ccq_payload}"',
    'exec "${ccq_interp}" "${ccq_payload}" "$@"',
    '',
  ];

  const outputPath = path.join(outputDir, unixArtifact.OutputFile);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  fs.writeFileSync(outputPath, lines.join('\n'), 'utf8');
  fs.chmodSync(outputPath, 0o755);
  pass(`已生成: ${outputPath}`);
  validateUnixDispatcher(outputPath, markers, { macOS: macPayload.content, linux: linuxPayload });
  return outputPath;
}

function extractHeredoc(content, marker) {
  const opener = `<<'${marker}' || { rm -f "\${ccq_payload}"; exit 1; }\n`;
  const start = content.indexOf(opener);
  if (start < 0 || content.indexOf(opener, start + 1) >= 0) return null;
  const bodyStart = start + opener.length;
  const end = content.indexOf(`\n${marker}\n`, bodyStart);
  return end < 0 ? null : content.slice(bodyStart, end);
}

function validateUnixDispatcher(outputPath, markers, payloads) {
  const label = path.basename(outputPath);
  const content = readText(outputPath);
  if (!content.startsWith('#!/bin/sh\n')) fail(`${label} 缺少 #!/bin/sh shebang`);
  for (const required of [
    'case "${ccq_os}" in',
    '  Darwin)',
    '  Linux)',
    'export CCQ_STREAMED_SCRIPT_PATH="${ccq_payload}"',
    'exec "${ccq_interp}" "${ccq_payload}" "$@"',
  ]) {
    if (!content.includes(`\n${required}\n`)) fail(`${label} dispatcher 缺少结构行: ${required}`);
  }
  for (const [name, marker] of Object.entries(markers)) {
    if (extractHeredoc(content, marker) !== payloads[name]) fail(`${label} 的 ${name} payload heredoc 不完整或与生成内容不一致`);
  }
  syntaxCheck('sh', label, content);
}

function ensureExpectedOutputs(manifest) {
  const expected = manifest.BuildEntrypoints.Unix.Artifacts;
  for (const fileName of expected) {
    const fullPath = path.join(outputDir, fileName);
    if (!fs.existsSync(fullPath)) fail(`缺少预期输出文件: ${fullPath}`);
  }
  // 注释：不再禁止 Windows 产物存在，允许两个平台产物共存
  pass(`输出文件集合检查通过: ${expected.join(', ')}`);
}

const manifest = readJson('installer/contracts/build.json');
const stepsContract = readJson(manifest.MacOS.StepContract || 'installer/contracts/steps.json');
fs.mkdirSync(outputDir, { recursive: true });
// 不预删已跟踪脚本或其他平台产物。

console.log('═══════════════════════════════════════════════════════════════');
console.log('  Claude Code 安装器 - Unix（macOS / Linux）单文件构建工具');
console.log('═══════════════════════════════════════════════════════════════');
console.log(`安装器根目录: ${installerRoot}`);
console.log(`输出目录:     ${outputDir}`);
console.log(`构建平台:     ${platform}`);

for (const artifact of manifest.Unix.Artifacts) buildUnixDispatcher(manifest, stepsContract, artifact);
// 声明 OutputFile 的 macOS payload（download-tui.zsh）仍直接输出，兼容既有 Raw URL。
for (const artifact of manifest.MacOS.Artifacts) {
  if (artifact.OutputFile) buildMacOSArtifact(manifest, stepsContract, artifact.Role);
}

ensureExpectedOutputs(manifest);
console.log('');
console.log('[PASS] Unix 构建完成');
NODE_SCRIPT
