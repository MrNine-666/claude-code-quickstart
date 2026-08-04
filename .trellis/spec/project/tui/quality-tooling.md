# TUI Quality Tooling Contract

## 1. Scope / Trigger

修改 `tui/src`、`tui/scripts`、`tui/tests`、`tui/package.json`、`tui/biome.json` 或 `.github/workflows/tui-quality.yml` 时适用。本合同规定 Bun 是唯一开发/测试运行时，Biome 仅用于开发期格式化与 lint，现有 `verify-*.mjs` 套件作为合同层。

## 2. Signatures

```sh
cd tui
bun run format          # bun scripts/biome-format.mjs --write
bun run format:check    # bun scripts/biome-format.mjs
bun run lint            # Biome errors across src/scripts/tests
bun run typecheck       # strict tsconfig, no emit
bun run test            # bun:test files under tests/
bun run verify          # legacy contract/integration chain
bun run check           # all gates above, in that order
```

本地可选 `CCQ_FORMAT_BASE=<git-object>`，CI 必须提供。formatter driver 只接受可选的 `--write` flag。

## 3. Contracts

- Runtime/tool 版本：`package.json` 与 `bun.lock` 中均固定 `packageManager=bun@1.3.14`、`@biomejs/biome=2.5.4`，并将 `@opentui/core`、`@opentui/keymap`、`@opentui/react` 整组锁定到 `0.4.5`。
- 未设置 `CCQ_FORMAT_BASE` 时，本地 format 选择已暂存 tracked files，以及 `src/`、`tests/` 下的 untracked files。
- 设置 `CCQ_FORMAT_BASE` 时，CI format 选择 `CCQ_FORMAT_BASE...HEAD` 中 added/copied/modified/renamed files，以及 untracked files；范围限制为 `src/`、`tests/` 和支持的 JS/TS/JSON 扩展名。
- 格式化绝不扫描未触及的 legacy source。完整 `src` 重排必须单独提交 cleanup change。
- Lint 扫描 `src`、`scripts` 和 `tests`；recommended error diagnostics 会使命令失败。`biome.json` 中的显式规则例外用于记录不兼容的 legacy React/ANSI patterns，不得静默改变行为。
- 新测试使用 `bun:test`。Headless OpenTUI 测试使用 `@opentui/react/test-utils`、固定尺寸，并在 `finally` 中清理 renderer。
- Quality CI 在 `macos-latest` 运行，检出完整历史，使用 `bun install --frozen-lockfile` 安装，权限为 `contents: read`，只运行 `bun run check`，绝不上传或发布 artifact。

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| 缺少 Biome executable | formatter 以非零退出，并提示使用 frozen install |
| `CCQ_FORMAT_BASE` 无效或不可用 | Git diff 以非零退出；format gate 以失败关闭 |
| 没有 staged/untracked 的本地格式候选文件 | 输出明确的通过消息并以 0 退出 |
| 候选文件需要重新格式化 | `format:check` 以非零退出；`format` 只写入候选文件 |
| Biome error diagnostic | `lint` 以非零退出 |
| Bun test assertion 或 renderer setup 失败 | `test` 以非零退出；renderer 仍在 `finally` 中销毁 |
| 任一 aggregate stage 失败 | 后续 `check` stage 不运行，CI 失败 |

## 5. Good / Base / Bad Cases

- 良好：PR 修改 `src/core/example.ts`；CI 提供 base SHA，Biome 检查该文件，然后运行 lint/typecheck/test/verify。
- 基线：本地仅修改文档时没有 `src/tests` format candidates，但 lint 与其余 aggregate gate 仍执行。
- 错误：将 `biome format src tests --write` 作为常规 gate，重写无关 legacy files；这违反工作区保留规则。

## 6. Tests Required

- Pure test：断言 owner core function 的正常、边界和 malformed/empty 行为。
- Renderer test：等待可见 frame 内容并断言真实 terminal output；始终在 `act()` 与
  `finally` 中销毁 renderer。
- Tooling 变更：断言 package command 顺序、CI frozen install/read-only 权限与 base
  SHA wiring、无 artifact action，并运行 `bun run check`。
- Compile/embedded/platform 变更除本质量门禁外，还必须运行 four-target
  build/smoke 矩阵。

## 7. Wrong vs Correct

### Wrong

```json
{"format:check": "biome format src tests"}
```

这会把渐进采用变成整个子系统的格式迁移，并掩盖无关改动。

### Correct

```json
{"format:check": "bun scripts/biome-format.mjs"}
```

CI 提供 `CCQ_FORMAT_BASE`；本地开发者暂存预期的 tracked files。两条路径都在改动边界执行 Biome，不声称 legacy files 已经格式化。
