# Development Workflow Guide

This guide is the current Trellis home for the durable development rules migrated
from the now-deleted `.context/prefs/` directory. It has no runtime dependency on
that historical source.

## Before Any Change

Ask and verify:

1. Is this a real current problem, or a historical/assumed one?
2. Which existing contract, registry, parser, component or service owns it?
3. Which callers, config fields, platforms and user workflows can be affected?

Read the relevant spec index and use CodeGraph first when `.codegraph/` exists.
If CodeGraph fails, diagnose once and then use direct source evidence; do not
guess from old plans.

## Repository Working Tree

- Work directly on the repository's `main` checkout for normal development.
- Do not create or enter a git worktree unless the user explicitly authorizes
  it. If an old worktree exists, reconcile or remove it before continuing when
  it affects the requested change.

## Feature

- Define current behavior, desired behavior and non-goals.
- Trace the complete data flow and ownership boundaries.
- Implement the smallest coherent change using existing patterns.
- Add focused verification, then run typecheck/full domain gates.
- Update the owning code spec when a contract or convention changed.

## Bug Fix

- Reproduce the symptom and identify the root cause.
- Add a failing regression when the behavior is testable in isolation.
- Fix the owner, not a downstream presentation symptom.
- Run the focused regression and relevant broader gates.
- Preserve the root cause and prevention rule in the owning spec when reusable.

## Refactor

- Establish passing behavior gates first.
- Keep steps small and externally behavior-preserving.
- Do not mix a broad rename/layout cleanup with a lifecycle/config change unless
  required for correctness.

## Language and Safety Checks

- PowerShell: PS5.1-compatible, StrictMode-safe arrays, no PS7-only syntax.
- zsh/bash: quote expansions, use the platform's established condition/error
  style, and do not import Windows mechanisms.
- TypeScript: `const`/`let`, async/await, explicit results and no swallowed
  primary errors.
- Security: validate trust boundaries and never expose tokens, keys or secret
  config source in logs/errors.

## Completion

- Focused tests pass.
- TUI changes pass `cd tui && bun run check`; before a local run, stage the
  intended tracked `src/tests` files or set `CCQ_FORMAT_BASE` so the change-scoped
  formatter checks the same boundary that CI will check.
- Required typecheck/full verify/build/contract gates pass for the blast radius.
- `git diff --check` is clean for tracked changes.
- User-owned/unrelated changes are preserved.
- Specs and indexes match the implemented contract; no future proposal is
  described as current behavior.
