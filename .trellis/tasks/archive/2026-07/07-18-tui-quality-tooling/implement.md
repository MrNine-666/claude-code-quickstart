# TUI Quality Tooling Implementation Plan

## 1. Establish A Green Existing Baseline

- [x] Re-run the focused config-view verification and confirm the active
  `[features]` recommendation mismatch.
- [x] Update only the stale assertion and add/retain assertions for the active
  memories fields.
- [x] Run the focused script, `bun run typecheck`, and `bun run verify`.

## 2. Add Biome Without Broad Churn

- [x] Add a pinned `@biomejs/biome` dev dependency and update `bun.lock` through
  Bun's package manager.
- [x] Add `tui/biome.json` using the dominant source format and recommended lint
  baseline.
- [x] Add `format`, `format:check`, and `lint` scripts with the agreed paths.
- [x] Run Biome diagnostics before writes and review every required source
  correction against existing user changes.
- [x] Keep legacy `scripts` outside the formatter command while resolving lint
  findings with minimal targeted edits or justified narrow rule configuration.

## 3. Add Standard Bun Tests

- [x] Add `tui/tests/core/text-utils.test.ts` or an equivalent isolated core
  test using `bun:test`.
- [x] Add `tui/tests/components/status-dot.test.tsx` or an equivalent small
  headless OpenTUI component test using fixed terminal dimensions and cleanup.
- [x] Add the `test` package script and verify discovery/filter behavior.

## 4. Add The Aggregate Gate

- [x] Add `bun run check` in dependency order: format check, lint, typecheck,
  test, verify.
- [x] Run each focused command and then the aggregate command locally.

## 5. Add Pull-Request CI

- [x] Add `.github/workflows/tui-quality.yml` for pull requests and pushes to
  `main` with TUI-relevant path filters.
- [x] Use `macos-latest`, Bun `1.3.14`, frozen-lockfile installation, minimal
  permissions, and `bun run check`.
- [x] Validate workflow syntax and confirm it contains no release/artifact
  operations.

## 6. Update Durable Specs

- [x] Update backend and frontend quality specs with the standard test split,
  Biome commands, and aggregate gate.
- [x] Update the development workflow only if the canonical completion command
  changes its durable project-wide guidance.

## 7. Final Verification And Review

- [x] Run `bun run format:check`.
- [x] Run `bun run lint`.
- [x] Run `bun run typecheck`.
- [x] Run `bun test`.
- [x] Run `bun run verify`.
- [x] Run `bun run check` from `tui/`.
- [x] Run `git diff --check` and inspect the complete scoped diff.
- [x] Confirm unrelated working-tree changes remain present and unmodified
  except where the agreed source quality baseline necessarily overlaps.

## Risk And Rollback Points

- Dependency installation may require network approval; stop before changing
  package metadata manually if Bun cannot resolve the pinned package.
- Biome may expose many legacy diagnostics. Prefer scoped configuration or
  minimal fixes over weakening unrelated TypeScript/runtime contracts.
- If headless rendering proves unstable on the pinned OpenTUI version, keep the
  pure Bun test and adapt the renderer test to the existing verified
  `testRender` lifecycle instead of adding another framework.
- Do not alter Build and Release artifact production while adding the quality
  workflow.
