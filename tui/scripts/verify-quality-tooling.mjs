// TUI 质量工具链的最小 CI/门禁契约（仅保留 K1–K6 六类）。
//
// K1 门禁完整性：`pkg.scripts.check` 字面量（`verify` 必须仍在链上）
// K2 测试分层：`pkg.scripts.test` 字面量（渲染测试不得被塞回 `--parallel`）
// K3 CI 真跑聚合门禁：workflow 含 `run: bun run check`
// K4 CI 权限边界：`contents: read`，且无 artifact / `contents: write`
// K5 供应链：`bun install --frozen-lockfile`
// K6 禁用的测试运行时：无 `vite` / `vitest`
//
// 其余断言（依赖版本号锁定、`biome.json` 配置项、format/lint/typecheck/verify
// 等 scripts 字面量、formatter 实现细节、workflow 触发路径 / runs-on /
// bun-version / action SHA 遍历）已于 P1 批删除，降级为人工 Review Checklist，
// 见 .trellis/spec/project/tui/quality-tooling.md §6 与 §3。
import assert from 'node:assert/strict';
import {readFileSync} from 'node:fs';
import {join} from 'node:path';

const root = join(import.meta.dirname, '..');
const repoRoot = join(root, '..');
const read = path => readFileSync(path, 'utf8');
const pkg = JSON.parse(read(join(root, 'package.json')));
const workflow = read(join(repoRoot, '.github', 'workflows', 'tui-quality.yml'));

assert.equal(pkg.scripts.test, 'bun test tests/core --parallel && bun test tests/components');
assert.equal(pkg.scripts.check, 'bun run format:check && bun run lint && bun run typecheck && bun run test && bun run verify');
assert.equal(JSON.stringify({...pkg.dependencies, ...pkg.devDependencies}).match(/vite|vitest/i), null);

assert.match(workflow, /contents: read/);
assert.match(workflow, /bun install --frozen-lockfile/);
assert.match(workflow, /run: bun run check/);
assert.doesNotMatch(workflow, /upload-artifact|action-gh-release|contents: write/);

console.log('[PASS] TUI quality tooling：仅保留 6 条最小 CI/门禁契约（gate 链 / test 分层 / 冻结安装 / CI 权限 / 无 vitest）');
