# TUI Quality Tooling Contract

## 1. Scope / Trigger

This contract applies when changing `tui/src`, `tui/scripts`, `tui/tests`,
`tui/package.json`, `tui/biome.json`, or `.github/workflows/tui-quality.yml`.
It keeps Bun as the only development/test runtime, Biome as a development-only
formatter/linter, and the existing `verify-*.mjs` suite as the contract layer.

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

`CCQ_FORMAT_BASE=<git-object>` is optional locally and required in CI. The
formatter driver accepts only the optional `--write` flag.

## 3. Contracts

- Runtime/tool versions: `packageManager=bun@1.3.14` and pinned
  `@biomejs/biome=2.5.4` in both `package.json` and `bun.lock`.
- Local format selection, without `CCQ_FORMAT_BASE`: staged tracked files plus
  untracked files under `src/` and `tests/`.
- CI format selection, with `CCQ_FORMAT_BASE`: added/copied/modified/renamed
  files in `CCQ_FORMAT_BASE...HEAD`, plus any untracked files, restricted to
  `src/` and `tests/` and supported JS/TS/JSON extensions.
- Formatting never sweeps untouched legacy source. A full `src` reformat belongs
  in a dedicated cleanup change.
- Lint scans `src`, `scripts`, and `tests`; recommended error diagnostics fail
  the command. Explicit rule exceptions in `biome.json` document incompatible
  legacy React/ANSI patterns rather than silently editing behavior.
- New tests use `bun:test`. Headless OpenTUI tests use
  `@opentui/react/test-utils`, fixed dimensions, and renderer cleanup in
  `finally`.
- Quality CI runs on `macos-latest`, checks out full history, installs with
  `bun install --frozen-lockfile`, has `contents: read`, runs only
  `bun run check`, and never uploads or publishes artifacts.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Biome executable missing | formatter exits nonzero with the frozen-install instruction |
| Invalid or unavailable `CCQ_FORMAT_BASE` | Git diff exits nonzero; format gate fails closed |
| No staged/untracked local format candidates | explicit pass message and exit 0 |
| Candidate would be reformatted | `format:check` exits nonzero; `format` writes only candidates |
| Biome error diagnostic | `lint` exits nonzero |
| Bun test assertion or renderer setup fails | `test` exits nonzero; renderer still destroys in `finally` |
| Any aggregate stage fails | later `check` stages do not run and CI fails |

## 5. Good / Base / Bad Cases

- Good: a PR changes `src/core/example.ts`; CI supplies the base SHA and Biome
  checks that file, then lint/typecheck/test/verify all run.
- Base: a local docs-only edit yields no `src/tests` format candidates, while
  lint and the remaining aggregate gates still execute.
- Bad: `biome format src tests --write` is run as the normal gate and rewrites
  unrelated legacy files; this violates working-tree preservation.

## 6. Tests Required

- Pure test: assert normal, boundary, and malformed/empty behavior of an owning
  core function.
- Renderer test: wait for visible frame content and assert the real terminal
  output; always destroy the renderer inside `act()` and `finally`.
- Tooling changes: assert package command order, CI frozen install/read-only
  permissions/base SHA wiring, no artifact actions, and run `bun run check`.
- Compile/embedded/platform changes still require the four-target build/smoke
  matrix in addition to this quality gate.

## 7. Wrong vs Correct

### Wrong

```json
{"format:check": "biome format src tests"}
```

This converts adoption into a subsystem-wide formatting migration and obscures
unrelated changes.

### Correct

```json
{"format:check": "bun scripts/biome-format.mjs"}
```

CI supplies `CCQ_FORMAT_BASE`; local developers stage intended tracked files.
Both paths enforce Biome on the change boundary without claiming legacy files
are already formatted.
