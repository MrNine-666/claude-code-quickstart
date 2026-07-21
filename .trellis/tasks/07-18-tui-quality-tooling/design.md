# TUI Quality Tooling Design

## Overview

The TUI remains a Bun/OpenTUI application. Quality tooling is added around the
existing runtime and verification contracts instead of introducing a browser
bundler or replacing the current test scripts.

The resulting local and CI flow is:

```text
Biome format check -> Biome lint -> TypeScript -> bun:test -> legacy verify
```

Every stage is independently runnable, while `bun run check` is the canonical
aggregate gate.

## Tooling Boundaries

### Bun

- Continues to run development, TypeScript entrypoints, tests, verification,
  and compiled builds.
- `bun:test` becomes the standard runner for new isolated and headless-renderer
  tests.
- Existing top-level assertion scripts remain contract/integration gates under
  `bun run verify`.

### Biome

- Added as a pinned TUI dev dependency with `tui/biome.json` as the only lint
  and formatting configuration.
- Lint input: `src`, `scripts`, and `tests`.
- Format input: changed/staged files under `src` and `tests` only for the
  initial baseline. Local runs use staged + untracked files; CI supplies a base
  SHA and checks the full commit range.
- Import organization is not applied automatically in this task to avoid broad
  reorder churn.
- Formatting follows the dominant TUI source style: tabs, single quotes, and no
  spaces inside import/object braces where supported.
- Generated output, `node_modules`, `bun.lock`, contracts, and binary assets are
  outside the explicit command paths.

### TypeScript

- The current strict `tsconfig.json` remains the source of type correctness.
- Biome complements rather than replaces `tsc`; no duplicate type-aware lint
  stack is introduced.

## Test Architecture

New tests live under `tui/tests/` and use Bun's built-in runner.

- A core test covers representative pure utility behavior, including edge
  cases not expressed clearly by the standard test runner today.
- A component test uses `@opentui/react/test-utils` to render a small shared
  component such as `StatusDot` or `ActionHint` at a fixed terminal size and
  assert visible output.
- Renderer setup is destroyed after every test to avoid native resource leaks.
- Existing `verify-*.mjs` scripts continue to own broad domain, filesystem,
  CLI, compiled-host, and cross-layer contracts.

The new tests demonstrate the standard structure without duplicating or
migrating the full legacy suite.

## Package Scripts

`tui/package.json` gains focused commands with stable ownership:

- `format`: write formatting for staged/untracked `src` and `tests` files.
- `format:check`: check the same local boundary; CI expands it from the supplied
  base SHA through `HEAD`.
- `lint`: lint `src`, `scripts`, and `tests`.
- `test`: run Bun test files under `tests`.
- `check`: run format check, lint, typecheck, test, and verify in order.

The existing `verify`, build, and platform smoke commands remain intact except
for correcting the stale config-view assertion.

## CI Design

A dedicated workflow runs on pull requests and pushes to `main`, with path
filtering for TUI source/tooling and the workflow itself.

- Runner: `macos-latest`, because `verify-compiled-contracts.mjs` validates only
  supported Windows/macOS executable targets and rejects Linux hosts.
- Bun version: `1.3.14`, matching `packageManager` and the release workflow.
- Install: `bun install --frozen-lockfile` in `tui/`.
- Gate: `bun run check`.
- Permissions: read-only repository contents.
- No artifact upload, tag mutation, or release permissions.

The existing Build and Release workflow remains responsible for cross-platform
builds and release artifacts.

## Compatibility And Migration

- No runtime dependency is added to compiled executables; Biome is a
  development-only dependency.
- No Vite/Vitest configuration is created.
- No existing verification script is removed.
- Existing source may receive only the minimum formatting/lint corrections
  necessary for the agreed `src` baseline. Overlapping user edits must be
  preserved semantically and reviewed file by file.

## Rollback

The change is reversible by removing the Biome dependency/configuration, new
package scripts/tests/workflow, and spec additions. The existing `verify`,
typecheck, development, build, and release commands continue to function
independently throughout the change.
