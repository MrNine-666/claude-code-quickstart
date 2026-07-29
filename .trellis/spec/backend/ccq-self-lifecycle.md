# ccq Self-Lifecycle Contract

## 1. Scope / Trigger

Apply this contract whenever code checks, downloads, replaces, restarts, or
uninstalls the `ccq` executable. The flow crosses an external Release API, the
filesystem, CLI/TUI callers, and platform-specific process semantics.

The executable being modified may be the current process. Never assume a path
that is writable is also replaceable or deletable while the process is alive.

## 2. Signatures

```typescript
checkLatestVersion(deps?): Promise<CheckLatestVersionResult>
downloadUpdate(
  plan: SelfUpdatePlan,
  signal?: AbortSignal,
  deps?: DownloadUpdateDeps
): Promise<DownloadUpdateResult>
applyUpdate(transaction: DownloadedSelfUpdate, options?): Promise<ApplySelfUpdateResult>
restartExecutable(targetPath?, spawnProcess?): Promise<ApplySelfUpdateResult>

uninstallSelfExecutable(targetPath, deps?): Promise<SelfUninstallResult>
```

CLI policy:

```text
ccq update [--check]       # CLI passes restartAfterApply=false
ccq uninstall [--yes|-y]  # Windows current exe returns scheduled
```

TUI policy: applying a downloaded transaction passes
`restartAfterApply=true`; renderer cleanup must happen before process exit or a
POSIX restart spawn.

## 3. Contracts

`SelfUpdatePlan` is the immutable Release capability. Final executable integrity
and network transport integrity are separate trust boundaries; neither may be
inferred from the other or from a filename.

```typescript
type SelfUpdateAsset = {
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly expectedSize: number;
  readonly expectedSha256: string; // normalized 64 lowercase hex
};

type SelfUpdateTransport = SelfUpdateAsset & {
  readonly encoding: 'gzip' | 'identity';
};

type SelfUpdatePlan = {
  readonly version: string;
  readonly target: SelfUpdateAsset;              // always the raw executable
  readonly transports: readonly SelfUpdateTransport[]; // priority order
};
```

`checkLatestVersion` fails closed without a valid raw asset and synthesizes the
`identity` transport from it. A valid `<asset>.gz` becomes the first transport;
a missing or malformed gzip entry is ignored so old and rolled-back Releases stay
directly upgradable. Apply code reads integrity facts from `plan.target` only and
never sees a compressed file.

`DownloadedSelfUpdate` binds the verified plan to one unique temp file and its
target. `applyUpdate` must consume this object; callers must not reconstruct a
temp path or pass a bare URL between stages.

```typescript
type DownloadedSelfUpdate = {
  readonly plan: SelfUpdatePlan;
  readonly targetPath: string;
  readonly tempPath: string;
};

type DownloadUpdateProgress = {
  readonly downloadedBytes: number;
  readonly totalBytes: number;   // current transport.expectedSize
  readonly percentage: number;   // integer, clamped to 0..100
  readonly assetName: string;    // which transport is on the wire
  readonly encoding: 'gzip' | 'identity';
};

type DownloadUpdateDeps = {
  // Other test seams omitted here.
  readonly onProgress?: (progress: DownloadUpdateProgress) => void;
};
```

### Transport Layer

- Every Release transport download disables automatic redirects and follows at
  most five HTTPS hops itself. Bun's automatic redirect from `github.com` to
  `release-assets.githubusercontent.com` aborts before the first body chunk, so
  each hop is issued explicitly with the Range header and AbortSignal preserved.
  A missing `Location`, an unparsable value, a protocol downgrade, a loop or an
  over-limit chain fails closed. Each retry restarts from the original GitHub URL
  so a fresh signed CDN location is issued.
- Transport partials live under `selfUpdateCacheDir()` (`~/.ccq/self-update`,
  `CCQ_HOME`-injectable). Each entry is keyed by transport digest and holds
  `metadata.json`, `payload.part` and `lease.json`. Metadata binds schema,
  version, platform, asset name, encoding, transport size/digest and target
  digest; any mismatch, oversize payload or malformed entry is discarded. Existing
  bytes are rehashed before append, so the final digest stays authoritative.
- At offset zero a successful full response is accepted. At offset > 0 the
  response must be `206` with `Content-Range` start equal to the offset, end
  equal to `expectedSize - 1` and total equal to `expectedSize`; an optional
  `Content-Length` must equal the remaining span. A `200` that ignores Range
  invalidates the partial and restarts from zero instead of appending.
- Retries are bounded at four attempts with 250/500/1000ms abortable backoff for
  network errors, body-stream errors, premature EOF, 408/429 and transient 5xx.
  Caller cancel, invalid redirect/range, permanent 4xx and integrity failures are
  not retried inside the same transport. A resettable no-progress timer plus a
  60-minute overall cap replace any fixed wall clock, so a slow but advancing
  download is not killed.
- Cache lease creation is exclusive with heartbeat and stale reclaim, so two
  concurrent `ccq` processes never append to the same partial and a crashed
  owner cannot block updates forever. The writer keeps the lease through final
  transport verification, raw materialization and cache cleanup; cleanup never
  removes an entry owned by a live process. Explicit cancel removes the current entry;
  network failure, timeout and normal exit preserve it for resume. A new Release
  drops non-current digests and idle entries expire after seven days.
- A completed transport is verified against its own size/SHA-256, then
  materialized into `uniqueTempUpdatePath(targetPath)`: gzip streams through
  gunzip, identity streams directly. Output is capped at
  `plan.target.expectedSize` and must match the target size and SHA-256 exactly
  before `DownloadedSelfUpdate` is returned. Consumed cache is deleted only after
  a valid raw transaction exists; on materialization failure the raw temp and the
  invalid transport entry are removed and the raw transport is selected next.
  No archive paths are extracted, so gzip adds no path-traversal surface.
- Progress reports current network transport bytes, not decompressed bytes, and
  carries the transport asset name and encoding. A validated resume reports the
  cached offset and stays monotonic within one transport; a gzip-to-raw fallback
  is an explicit transport change that resets the total.

- Temp files live in the target directory, use exclusive creation, and include
  pid plus cryptographic randomness.
- Downloading is streamed while computing byte count and SHA-256.
- Progress starts at zero, never decreases within one transport, and is throttled
  to integer percentage changes. A resumed offset is published only after strict
  `206 Content-Range` validation. A `100%` event means all declared bytes were written; it
  is not success until size and SHA-256 validation complete. The TUI keeps the
  latest progress in `self-update-state.ts` during both downloading and
  cancelling, and renders a fixed-width bar plus downloaded/total bytes.
- POSIX applies `chmod(0755)` and `fsync` before same-directory `rename`.
- Windows writes an ASCII-compatible PS5.1 helper, waits for the parent pid,
  revalidates size/hash, retries the operation, and self-deletes. When the
  target exists, replacement uses same-directory
  `[System.IO.File]::Replace(temp, target, backup, true)`; it must never use
  `Copy-Item -Force` against the live target. A failed replacement preserves
  the old target and diagnostic temp. A failed post-replacement validation
  restores the backup before reporting failure; success removes the backup.
  Hashing uses `System.Security.Cryptography.SHA256` over a file stream; helper
  scripts must not depend on `Get-FileHash` or PowerShell module auto-loading.
- Bun 1.3.14 on Windows keeps `detached: true` children in a kill-on-close job
  object. Launch helpers through `cmd.exe /d /c start "" /b` and await the cmd
  bootstrap instead of relying on Bun/`node:child_process` detached semantics.
  Pass the PowerShell invocation as UTF-16LE `-EncodedCommand` so user paths do
  not cross the cmd parser as raw metacharacters.
- Report `scheduled` only after the cmd bootstrap exits zero and the helper
  writes its ready file before waiting for the parent. A missing ready file is
  a launch failure, not a best-effort warning.
- Windows update restarts only when `RestartAfterApply` is present. Windows
  uninstall never starts a process.
- Helper logs must not contain target/temp paths or raw exception messages.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| current/latest is invalid SemVer | `check` error; zero download |
| latest is equal/lower priority | `hasUpdate=false`; zero download |
| unsupported platform/architecture | structured `check` error |
| missing asset, non-positive integer size, missing/invalid SHA-256 | fail closed in `check` |
| Retryable HTTP/network/body failure or timeout | `download` error; preserve a valid transport partial for resume |
| Caller cancellation | `download` cancellation; delete the current transport cache entry |
| Disk write/fsync, invalid redirect/range or integrity failure | permanent transport failure; never append/retry unsafe bytes |
| downloaded size/hash mismatch | `download` error; target remains byte-identical |
| progress callback reaches `100%`, then hash mismatches | `download` error; never transition to ready/apply |
| temp path does not belong to target directory/prefix | `apply` error before target mutation |
| apply-time size/hash mismatch | `apply` error; preserve target and diagnostic temp |
| apply transaction temp is missing/invalid before mutation | `apply` error with `retryStage=download`; UI must not retry the same invalid transaction forever |
| Windows helper spawn emits asynchronous `error` | failure, never `scheduled` |
| Windows helper bootstrap exits nonzero or ready is absent | failure, never `scheduled` |
| `Get-FileHash` is absent or not auto-loaded | helper still verifies both files through the .NET SHA-256 implementation |
| Windows target stays locked through all retries | old target and verified temp remain byte-identical |
| Windows replacement succeeds but postflight fails | restore backup; do not restart the target |
| Windows current exe uninstall | `scheduled`; target remains until parent exits |
| non-current or POSIX uninstall | `deleted`, or structured error |

## 5. Good / Base / Bad Cases

- Good: stable `2.5.0` with a matching platform asset upgrades `2.4.0` after a
  streamed size/hash verification, while the TUI displays monotonic real byte
  progress.
- Base: `2.4.0+build-b` does not upgrade `2.4.0+build-a`; build metadata has no
  precedence. `2.4.0-beta.10` is newer than `2.4.0-beta.2`.
- Bad: a Release without `digest`, a fixed shared `.ccq-update.tmp`, or a
  Windows `rmSync(process.execPath)` must fail tests.
- Bad: overwriting `ccq.exe` in place with `Copy-Item -Force` can leave a
  truncated executable if the copy is interrupted or postflight validation
  fails.
- Bad: printing "updated" or "deleted" when a helper has only been scheduled
  is a user-visible contract violation.

## 6. Tests Required

- Release matrix: upgrade/equal/downgrade/prerelease/build metadata, invalid
  SemVer, asset/size/digest/platform failures, and zero-download check-only.
- Download runtime: 100 MiB chunked response, concurrent unique temp paths,
  cancellation/HTTP/size/hash cleanup, unchanged target assertions, and
  progress assertions for initial zero, monotonic bytes and final 100.
- OpenTUI progress render: use the real headless renderer at a fixed terminal
  size and assert the bar, percentage and downloaded/total byte text.
- POSIX apply: success bytes/mode plus pre-rename verification failure preserving
  target bytes.
- Spawn unit test: emit `error` after `spawn()` returns and assert failure.
- Windows native update helper: short lock, long lock, hash verification,
  atomic replace, preserved old target/temp on retry exhaustion,
  `restart=false`, and `restart=true` marker execution. Run the generated
  helper through `powershell.exe -NoProfile -File` and assert its source
  contains the .NET SHA-256/`File.Replace` paths and no `Get-FileHash` or
  in-place `Copy-Item -Force` dependency.
- Windows native uninstall helper: short lock deletion, long lock failure,
  helper cleanup, and no `Start-Process`.
- Compiled Windows smoke: copy to temporary `CCQ_HOME/.local/bin/ccq.exe`, run
  `uninstall --yes`, and poll for target/helper disappearance without TUI text.

All tests must use temporary `CCQ_HOME`; never modify the real installation.

## 7. Wrong vs Correct

### Wrong

```typescript
await downloadUpdate(downloadUrl); // writes a fixed shared temp path
await applyUpdate();               // re-derives paths and may consume another run
rmSync(process.execPath);          // fails for a running Windows image
Get-FileHash $TempPath;            // relies on module auto-loading in the helper
Copy-Item $TempPath $TargetPath -Force; // can corrupt the old target in place
```

### Correct

```typescript
const downloaded = await downloadUpdate(info.plan, signal, {
  onProgress: progress => dispatch({type: 'downloadProgress', progress})
});
if (!downloaded.ok) return downloaded;

const applied = await applyUpdate(downloaded.transaction, {
  restartAfterApply: caller === 'tui'
});

const uninstalled = await uninstallSelfExecutable(targetPath);
// Report scheduled separately from deleted/applied.

// Generated PS5.1 helper: stream the file through
// System.Security.Cryptography.SHA256 and dispose both objects in finally.
// After the parent exits and temp verifies:
// [System.IO.File]::Replace($TempPath, $TargetPath, $BackupPath, $true)
// Verify the target, restore $BackupPath on failure, then restart if requested.
```
