# TUI Quality Tooling

## Goal

Establish a lightweight, enforceable quality toolchain for the Bun/OpenTUI
subproject so formatting, static checks, automated tests, and the existing
contract verification run consistently before changes reach `main`.

Vite is not part of this work: the application runs directly on Bun/OpenTUI
and is distributed through `bun build --compile`, so a browser dev server or
browser-oriented bundler would add complexity without improving the current
runtime or release workflow.

## Background

- `tui/package.json` already provides `typecheck`, 46 chained
  `verify-*.mjs` commands, platform builds, and a Skills topology smoke test.
- The verification scripts are automated contract/integration checks, but the
  project has no `bun:test` suite, no lint/format configuration, and no single
  local quality command.
- Only two current verification scripts use OpenTUI's headless `testRender`;
  most checks use top-level `node:assert/strict` scripts.
- `.github/workflows/build-and-release.yml` runs on pushes to `main`, tags, and
  manual dispatch. Its TUI build job does not run the full `typecheck` or
  `verify` gates, and there is no pull-request quality workflow.
- On the current checkout, `bun run typecheck` passes. `bun run verify` stops
  in `scripts/verify-config-view.mjs` because the assertion expects a commented
  `# [features]` table while the current embedded recommendation contains the
  active `[features]` table.
- `verify-compiled-contracts.mjs` intentionally supports Windows and macOS
  targets only. Running the aggregate `verify` command unchanged on an Ubuntu
  CI host would fail before proving the supported-platform executable contract.
- The working tree contains unrelated user changes, including TUI source and
  verification files. This task must preserve them and avoid broad formatting
  churn across overlapping files.

## Requirements

- R1: Keep Bun as the development, test, and build runtime; do not add Vite or
  Vitest.
- R2: Repair the current `verify-config-view.mjs` expectation so the full
  existing verification gate reflects the active recommendation contract.
- R3: Add Biome as the TUI-scoped formatter and linter with repository-visible
  configuration and package scripts for linting, formatting, and format checks.
- R4: Add a standard `bun:test` entry point and representative tests for
  isolated runtime logic and OpenTUI rendering/interaction behavior.
- R5: Preserve the existing `verify-*.mjs` suite as contract/integration tests;
  do not migrate all scripts in this change.
- R6: Add one aggregate local quality command covering format check, lint,
  TypeScript, Bun tests, and the existing verification suite.
- R7: Add one `macos-latest` GitHub Actions quality job for pull requests and
  pushes to `main`. It must install the Bun version pinned by
  `tui/package.json` and execute the same aggregate quality command used
  locally, including the supported-platform compiled-contract probe.
- R8: Keep release builds and platform-specific smoke tests in their current
  workflow; the new quality workflow must not publish artifacts.
- R9: Scope Biome linting to `tui/src`, `tui/scripts`, and the standard test
  directory. Scope the initial format gate to changed/staged files under
  `tui/src` and tests; untouched legacy source and all legacy scripts remain
  outside formatting until a dedicated cleanup change. Exclude generated
  output, dependencies, lock files, and binary assets.
- R10: Avoid a repository-wide reformat in the behavior/tooling change. Any
  unavoidable baseline formatting edits must be explicit and reviewable.

## Acceptance Criteria

- [x] `tui` has no Vite or Vitest dependency/configuration.
- [x] `bun run verify` completes successfully on the supported development
  platform after the stale config-view assertion is corrected.
- [x] `bun run lint` reports no lint failures for the configured TUI scope.
- [x] `bun run format:check` reports no formatting failures for the configured
  TUI scope without reformatting unrelated user changes.
- [x] `bun test` discovers and passes the new standard test files.
- [x] At least one Bun test exercises isolated non-rendering logic and at least
  one test uses OpenTUI's headless renderer for visible or interaction behavior.
- [x] `bun run check` runs format, lint, typecheck, Bun tests, and the legacy
  verification gate and exits nonzero if any stage fails.
- [x] A GitHub Actions workflow runs the TUI quality command for pull requests
  and pushes to `main`, installs with the frozen Bun lockfile, and does not
  upload or release artifacts.
- [x] Existing release build behavior and the four executable artifact contract
  remain unchanged.
- [x] Relevant Trellis quality/development specs describe the resulting current
  commands and testing convention.
- [x] User-owned and unrelated working-tree changes are preserved.

## Out Of Scope

- A browser preview, web administration interface, or documentation site.
- Replacing Bun's compiler or the four-platform release build.
- Migrating all existing verification scripts to `bun:test`.
- Establishing lint/format policy for the PowerShell and zsh installers.
- Enabling coverage thresholds in the first iteration.
