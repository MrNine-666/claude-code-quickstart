# TUI Self-Update Transport Reliability Implementation Plan

## Preconditions

- Do not run `task.py start` until the user reviews and explicitly approves the
  final PRD/design/implementation summary.
- Before product edits, load `trellis-before-dev` and backend self-lifecycle,
  error-handling, quality and installer build-release specs.
- Preserve the user's uncommitted Enter-retry changes in `app.tsx`,
  `self-update-state.ts` and `verify-self-update.mjs`, plus unrelated dirty work.
- Keep the Windows helper contract unchanged unless a new red test proves a
  separate defect.

## 1. Establish Red Contract Gates

- [ ] Extend `verify-self-update.mjs` with raw target + gzip/raw transport plan
      fixtures, four platform mappings and malformed/missing gzip fallback.
- [ ] Add manual redirect, mid-stream error/EOF, strict Range, bounded retry and
      timeout fixtures before production changes.
- [ ] Add cross-call cache tests for resume, metadata mismatch, TTL, new Release,
      cancel, success, concurrent lease and stale lock.
- [ ] Add gzip/raw materialization size/hash/overflow/decoder failure cases and
      explicit raw fallback/progress reset assertions.
- [ ] Extend installer contract tests for four raw-to-gzip mappings and exact 10
      Release artifacts while retaining existing UI/helper assertions.

## 2. Add Deterministic Gzip Packaging

- [ ] Add a repo-owned Bun packaging helper that writes deterministic `.gz`,
      repeats compression to prove byte stability and verifies roundtrip bytes.
- [ ] Extend `installer/contracts/build.json` with raw-to-gzip mappings and the
      exact 10-file Release set; do not create a second filename source.
- [ ] Wire `tui/scripts/build.ts`/Release workflow after final version/icon bytes.
- [ ] Update CI upload/download, expected count, Release body and failure output;
      any missing gzip blocks the complete Release.
- [ ] Keep Windows/macOS installer initial handoff on raw assets.

## 3. Redesign Release Plan Types

- [ ] Introduce immutable raw target and encoded transport descriptors.
- [ ] Require valid raw asset/digest and synthesize identity transport.
- [ ] Prefer valid `.gz`; ignore missing/malformed gzip for old-release
      compatibility.
- [ ] Update CLI/TUI/state/helper references to read target facts from one plan.

## 4. Implement Persistent Cache Ownership

- [ ] Add `selfUpdateCacheDir()` in `core/paths.ts`, rooted at
      `~/.ccq/self-update` and isolated by temporary `CCQ_HOME` tests.
- [ ] Implement schema-validated atomic metadata, digest-keyed payload and
      exclusive lease/heartbeat/reclaim logic in core.
- [ ] Rehash valid partial bytes before append and invalidate unsafe state.
- [ ] Implement cancel, success, new-release, malformed and seven-day cleanup
      without deleting unrelated `~/.ccq` content.

## 5. Implement Manual Redirect And Strict Resume

- [ ] Fetch with `redirect: 'manual'`, HTTPS-only Location validation, loop
      detection, five-hop limit, shared AbortSignal and preserved Range.
- [ ] Retry from original GitHub URL four total times with 250/500/1000ms
      abortable backoff.
- [ ] Validate resumed `206 Content-Range` and optional Content-Length before
      append; safely restart/invalidate ignored Range.
- [ ] Add resettable no-progress timing and 60-minute cap; preserve valid
      partials on network/retry/timeout exhaustion and close descriptors.
- [ ] Return structured transient/cancel/cache-busy/permanent/disk/integrity
      failures.

## 6. Materialize And Fall Back

- [ ] Verify completed transport size/SHA-256 before materialization.
- [ ] Stream gunzip or identity bytes into a unique same-directory raw temp,
      enforcing raw size cap and computing target SHA-256.
- [ ] Return a transaction only after raw fsync/exact size/digest; clean raw temp
      on every materialization failure.
- [ ] On gzip unavailable/nonrecoverable failure, switch to identity raw and use
      the same persistent Range engine.
- [ ] Delete consumed cache only after a valid raw transaction exists.

## 7. Reconcile UI Progress And Retry

- [ ] Extend progress/state with current transport identity/encoding while
      retaining reducer exhaustiveness.
- [ ] Report validated cached offset, monotonic per-transport progress and an
      explicit gzip-to-raw reset/hint.
- [ ] Preserve check/download/apply Enter retry; download reuses matching cache,
      while Esc cancel deletes it.
- [ ] Keep copy concise and redact signed Location URLs.

## 8. Synchronize Durable Specs And Navigation

- [ ] Update backend `ccq-self-lifecycle.md` with dual transport, persistent
      cache, redirects/Range, timeout, materialization, progress and fallback.
- [ ] Update installer `build-release.md` from 6 to 10 artifacts and document
      deterministic gzip/roundtrip gates.
- [ ] Update root/TUI navigation and Release docs only where they state artifact
      facts; keep exact lists contract-owned.
- [ ] Keep true delta deferred; add no patch assets/runtime in this task.

## 9. Focused Verification

```powershell
cd tui
bun scripts/verify-self-update.mjs
bun scripts/test-windows-helper.mjs
bun run typecheck
bun run build

cd ..
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/build.ps1
sh installer/build.sh --check
```

- [ ] Use only temporary `CCQ_HOME` and fake target executables.
- [ ] Prove all four gzip assets roundtrip to exact raw bytes.
- [ ] Prove target bytes never change during download/cache/decompress failure.
- [ ] Confirm native helper short/long lock, rollback and restart remain green.

## 10. Full Quality And Review Gate

```powershell
cd tui
bun run check
cd ..
git diff --check
```

- [ ] Review source/spec/contract/CI artifact lists as one fact chain.
- [ ] Preserve pre-existing user changes and concurrent unrelated tasks.
- [ ] Commit no signed URL, debug probe, real executable or cache payload.
- [ ] Treat the live GitHub probe as supporting, not deterministic, evidence.

## Completion Gate

Implementation completes only when AC1-AC10 have focused/full-gate evidence. A
UI retry alone, gzip without raw fallback, or resume lost after TUI restart does
not satisfy the task.
