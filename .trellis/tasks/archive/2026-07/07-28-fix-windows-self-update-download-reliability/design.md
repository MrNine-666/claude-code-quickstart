# TUI Self-Update Transport Reliability Design

## 1. Design Summary

The update pipeline gains a transport layer without changing the verified raw
transaction or platform apply layer. Releases keep all raw executables and add
deterministic gzip equivalents. New clients prefer gzip, persist transport
partials across runs, manually follow GitHub redirects, resume with strict
Range validation, materialize a fully verified raw temp, then reuse the current
Windows/POSIX apply paths.

Release packaging and client support ship atomically in one task: publishing
gzip without selection is unused, while selecting gzip before the release gate
exists strands updates. True binary delta remains a separate benchmark-gated
follow-up because it introduces a source-version matrix rather than a linear
per-platform transport.

## 2. End-To-End Flow

```text
final raw binaries
  -> deterministic gzip packaging
  -> exact 10-asset Release gate
  -> GitHub Release API returns raw target + gzip/raw transports
  -> prefer gzip (raw fallback always present)
  -> persistent transport cache + manual HTTPS redirect + strict Range
  -> verify transport size/SHA-256
  -> gzip: stream-decompress to same-directory raw transaction temp
     raw:  stream-copy to same-directory raw transaction temp
  -> verify raw size/SHA-256
  -> existing DownloadedSelfUpdate
  -> existing Windows helper or POSIX atomic apply
```

The original 0% failure is entirely before apply: Bun automatic redirect fails
before a response/first body chunk. The helper is not created until the final
raw transaction has passed both trust boundaries.

## 3. Release Artifact Contract

The exact current-platform Release set becomes:

```text
install.ps1
install.sh
ccq-windows-x64.exe
ccq-windows-x64.exe.gz
ccq-windows-arm64.exe
ccq-windows-arm64.exe.gz
ccq-macos-x64
ccq-macos-x64.gz
ccq-macos-arm64
ccq-macos-arm64.gz
```

Generate `.gz` only after the corresponding final raw file exists, using one
repo-owned Bun packaging script with deterministic headers/compression settings.
The script verifies decompression byte equality before success. `build.json`
owns names and raw-to-gzip mapping; `build.ts`, installer contract tests and CI
consume that mapping rather than duplicating independent lists. Initial install
continues to use raw assets.

## 4. Plan Model

Separate final executable integrity from network transport integrity:

```typescript
type SelfUpdateAsset = {
  readonly assetName: string;
  readonly downloadUrl: string;
  readonly expectedSize: number;
  readonly expectedSha256: string;
};

type SelfUpdateTransport = SelfUpdateAsset & {
  readonly encoding: 'gzip' | 'identity';
};

type SelfUpdatePlan = {
  readonly version: string;
  readonly target: SelfUpdateAsset;
  readonly transports: readonly SelfUpdateTransport[];
};
```

`checkLatestVersion()` requires a valid raw target and constructs identity from
it. A valid `.gz` becomes the first transport; absent/malformed gzip is ignored
with raw retained. Release CI requires gzip for new releases, while runtime
tolerance keeps new clients compatible with old or partially rolled-back
releases.

`DownloadedSelfUpdate` still contains a plan, target path and a same-directory
raw temp. Apply code reads target integrity from `plan.target`; it never sees a
compressed file.

## 5. Persistent Transport Cache

Add `selfUpdateCacheDir()` beside `ccqDir()` in `core/paths.ts`, resolving to
`~/.ccq/self-update` and respecting `CCQ_HOME` in tests. Each transport digest
owns a directory containing:

```text
metadata.json
payload.part
lease.json
```

Metadata records schema/version/platform/name/encoding/size/digest and target
digest, is written atomically and validated structurally. A mismatch, payload
larger than expected or impossible offset invalidates the entry. Before resume,
rehash existing bytes to rebuild the incremental transport hash; final digest
remains authoritative against local tampering.

Lease creation is exclusive. The active writer heartbeats while receiving
bytes/backing off; another process reports a typed busy result instead of
writing. A lease with no recent heartbeat and no live owner is reclaimable.
Cleanup runs during update checks/download start: remove non-current digest
entries, malformed entries and inactive entries older than seven days. Explicit
cancel removes current entry; network/timeout/normal-exit preserves it.

## 6. Manual Redirect And Retry

One logical request starts at the original GitHub asset URL and calls fetch with
`redirect: 'manual'`. It resolves relative Location values, permits HTTPS only,
detects loops and stops after five hops. AbortSignal and Range headers are sent
on every hop. Each retry starts at the original URL so GitHub can issue a fresh
signed CDN location.

Attempt policy:

- four total attempts, backoff 250/500/1000ms;
- retry fetch/network, body read, premature EOF, 408/429 and transient 5xx;
- do not retry caller cancel, invalid redirect/range, permanent 4xx, disk error,
  oversize or integrity failure inside the same transport attempt;
- reset a no-progress timer when bytes arrive, and cap one public operation at
  60 minutes; both use the same abortable settlement path;
- preserve a valid partial on network/retry/timeout exhaustion.

At offset zero accept a valid successful full response. At offset > 0 require
`206` with `Content-Range start=offset,total=transport.expectedSize`; validate
end and optional Content-Length before opening for append. If resume is ignored
with `200`, invalidate/restart the transport without appending the response.

## 7. Materialization And Integrity

After transport completion, fsync and verify transport byte count/SHA-256.
Materialize to `uniqueTempUpdatePath(targetPath)`:

- gzip: read verified cache through a streaming gunzip transform;
- identity: stream verified raw cache directly;
- stop immediately if output exceeds `plan.target.expectedSize`;
- stream output into the unique raw temp while hashing;
- fsync/close and require exact target size/SHA-256.

Only then return `DownloadedSelfUpdate`. Delete consumed cache after raw
materialization succeeds. On materialization failure, delete raw temp and
invalid transport cache, then select raw fallback when gzip was active. Raw
fallback uses the same cache/redirect/Range/materialization machinery.

No archive paths are extracted, so gzip introduces no path traversal surface.

## 8. Progress And UI State

Progress represents current network transport bytes/total, not decompressed
bytes. The reducer starts at zero; after a resumed Range response is validated,
core reports cached offset and continues monotonically. State carries transport
encoding/name so gzip-to-raw fallback is explicit: progress resets to zero with
the raw total and UI shows a concise fallback message.

Existing `SelfUpdateRetry` remains the manual recovery surface. Download retry
reuses matching persistent cache. Esc cancel aborts and deletes current entry;
network failure/timeout keeps it. Signed URLs remain out of normal UI copy.

## 9. Apply Compatibility

Windows remains:

```text
verified raw transaction
  -> create helper and await ready marker
  -> TUI destroys renderer/exits
  -> helper waits for parent exit
  -> revalidates raw temp
  -> File.Replace with bounded lock retry/backup
  -> verifies target, restores on failure
  -> starts updated executable only after success
```

POSIX keeps chmod/fsync/same-directory rename. Neither path learns about gzip,
cache metadata, redirects or fallback.

## 10. Verification Strategy

Deterministic gates cover:

- repeated gzip packaging equality and raw roundtrip for all four names;
- exact 10-artifact contract/build/CI lists;
- raw-required/gzip-optional Release plans and four-platform selection;
- manual redirect success plus downgrade/loop/missing/limit failures;
- first-run partial then second-run Range resume across a fresh call boundary;
- invalid 200/Content-Range/Content-Length and retry/permanent HTTP states;
- no-progress/overall timeout, abort during fetch/body/backoff and slow progress;
- cache schema/digest/length/TTL/new-release/cancel/success cleanup;
- concurrent writer lease and stale-lock recovery;
- transport/raw digest mismatch, gzip overflow/decoder failure and raw fallback;
- monotonic resumed progress and explicit fallback reset;
- existing UI retry, POSIX apply and Windows native helper tests.

Live GitHub probes are supporting evidence only; injected fetch/stream fixtures
own deterministic regression verdicts.

## 11. Rollout And Rollback

Old clients ignore `.gz` and keep downloading raw. New clients prefer gzip and
fall back raw, so either client or packaging behavior can be rolled back without
stranding users. Cache schema is versioned; incompatible rollback removes it.
No user configuration migration is introduced.

True delta is deferred. A later task benchmarks exact final artifacts across at
least three consecutive releases and proceeds only when median patch size is at
most 25% of gzip with acceptable runtime/memory and full fallback.
