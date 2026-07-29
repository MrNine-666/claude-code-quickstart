# ccq Update Distribution Options Research

Date: 2026-07-28

## Executive Conclusion

True binary delta updates are technically possible, but they should not be the
first reliability fix. For this repository, the best near-term design is:

1. keep the current raw executables as the universal/legacy fallback;
2. publish deterministic gzip update assets for new clients;
3. download the gzip transport with explicit redirects and strict Range resume;
4. verify the compressed asset, decompress to the existing raw transaction
   temp, then verify the final executable size/SHA-256;
5. preserve the existing Windows deferred `File.Replace` helper unchanged;
6. benchmark true delta generation in CI before committing to a source-version
   patch matrix.

This cuts measured transfer size by roughly 63%-65% without coupling each new
release to many prior releases. Delta patches may reduce it further, but only
after a client supporting the patch format is deployed and only for exact
known source binaries; a full fallback remains necessary.

## Current Facts

### Standalone artifact shape

`tui/scripts/build.ts` invokes `bun build --compile` for four platform/arch
targets. Bun documents this as generating a standalone executable from the
application and its runtime dependencies. The repository publishes the four
raw executables directly; there is no compression, patch manifest or delta
asset in `installer/contracts/build.json` or
`.github/workflows/build-and-release.yml`.

Primary source: [Bun single-file executables](https://bun.sh/docs/bundler/executables).

### Release size and cadence

GitHub's first-party Releases API returned these Windows x64 sizes:

| Release | Published | Bytes |
|---|---:|---:|
| v2.4.2 | 2026-07-24 | 109,262,848 |
| v2.4.1 | 2026-07-21 | 109,264,384 |
| v2.4.0 | 2026-07-18 | 109,238,272 |
| v2.3.1 | 2026-07-14 | 109,135,872 |
| v2.3.0 | 2026-07-13 | 109,124,096 |
| v2.2.2 | 2026-07-06 | 108,963,840 |
| v2.2.1 | 2026-07-02 | 108,960,256 |
| v2.2.0 | 2026-07-02 | 108,943,360 |
| v2.1.0 | 2026-07-01 | 108,930,560 |

That is nine full-binary releases in about 23 days. Similar file lengths do not
prove a small binary delta; executable layout and embedded runtime offsets can
change while total size stays almost constant.

Primary source: [GitHub REST Releases API](https://docs.github.com/en/rest/releases/releases?apiVersion=2022-11-28#list-releases).

### Transport behavior

GitHub's Release asset API says clients requesting
`application/octet-stream` must handle either a streamed `200` or a redirected
`302`. The live v2.4.2 probe observed a GitHub 302 and successful CDN `206`
Range responses when the signed URL was requested directly. The current Bun
automatic redirect path is the failing boundary.

Primary source: [GitHub REST release assets](https://docs.github.com/en/rest/releases/assets?apiVersion=2022-11-28#get-a-release-asset).

Local reproduction details: [diagnosis.md](./diagnosis.md).

## Compression Measurements

The measurements below used local executable bytes and Optimal ZIP/Deflate or
Bun 1.3.14 built-in compression. Temporary archives were deleted afterward.

| Artifact/sample | Raw | Compressed | Reduction |
|---|---:|---:|---:|
| installed v2.4.1 Windows x64, gzip -9 | 109.26 MB | 39.92 MB | 63.46% |
| installed v2.4.1 Windows x64, Bun zstd default | 109.26 MB | 38.19 MB | 65.04% |
| dev Windows arm64, ZIP | 104.31 MiB | 38.55 MiB | 63.04% |
| dev macOS x64, ZIP | 80.27 MiB | 28.05 MiB | 65.05% |
| dev macOS arm64, ZIP | 74.93 MiB | 25.98 MiB | 65.33% |

Bun 1.3.14 exposes `gzipSync`, `gunzipSync`, `zstdCompressSync`,
`zstdDecompressSync` and `DecompressionStream`. Zstd saved only about 1.7 MB
more than gzip for the real Windows release. Gzip is preferable initially
because it has standard streaming decompression and ubiquitous CI/installer
tooling; zstd's small extra saving does not justify a full-buffer or additional
streaming implementation unless later benchmarks change the result.

## Option Comparison

| Option | Typical transfer here | Implementation/release cost | Main limitation |
|---|---:|---|---|
| Raw executable + Range resume | ~109 MB | Low | Reliability improves, bandwidth does not |
| Gzip full executable + Range resume | ~40 MB | Medium | Adds transport assets and decompression step |
| True binary delta | Unknown until exact-artifact benchmark; potentially much smaller | High | Exact source-version matrix and patch runtime |
| MSIX/App Installer | Changed 64 KB blocks | Very high/platform-specific | Replaces current portable EXE/install model and requires trusted signing |
| Sparkle delta updates | Potentially small | Very high/platform-specific | macOS-only framework/distribution migration |
| Split Bun runtime from app payload | Later app updates could be small | Architectural rewrite | Loses one-file standalone contract; runtime now has its own lifecycle |
| Package manager/bootstrapper | Depends on package format | Medium-high | Does not inherently provide delta; changes installation ownership |

## Recommended Compressed-Full Design

### Release assets

Keep the raw four executables so every already released client can still find
the exact asset name it knows. Add one deterministic `.gz` transport per
platform for clients that understand compressed updates.

With the current four binaries, the exact Release set grows from six to ten
assets. If Linux x64/arm64 lands later, the same policy adds two raw plus two
compressed assets; this linear growth is still much smaller than a delta matrix.

### Plan and verification

The update plan needs two immutable asset descriptions:

```text
transport asset: .gz URL, compressed size, compressed SHA-256
target asset:    raw executable size, raw SHA-256
```

Download the compressed file to a unique transport temp using strict Range
resume. After its size/hash passes, stream-decompress it into the existing raw
update temp while computing raw size/hash. Only the verified raw temp becomes a
`DownloadedSelfUpdate`; the Windows apply helper receives the same transaction
shape and remains unaware of compression.

Do not stream-decompress directly from a network response if a retry would need
to restart the gzip decoder. Completing and verifying the resumable compressed
transport first makes network retries independent from decompressor state.

### Timeout correction

A fixed five-minute wall-clock timeout makes a 109 MB download impossible below
roughly 364 KB/s even if bytes continue arriving. Compression lowers that
threshold, but the downloader should still distinguish a stalled request from
a slow progressing request. Prefer a resettable no-progress timeout plus a
bounded overall safety cap, or explicitly preserve the verified partial
transport for a later resume. Caller cancellation should remain immediate and
must have an explicit cleanup policy.

## True Delta Feasibility

### Available algorithms

- `bsdiff` is designed for executable changes and its author reports smaller
  patches than older xdelta/RTPatch comparisons. It requires a compatible
  `bspatch` implementation and bzip2-format support in the client.
  Primary source: [bsdiff](https://www.daemonology.net/bsdiff/).
- Zstandard's official CLI provides `--patch-from FILE`, implemented as
  reference/dictionary compression with parameter selection for large source
  files. Generating patches in CI is straightforward, but the installed client
  must be able to decode with the exact old executable as reference; Bun's
  simple zstd convenience API does not by itself establish that patch contract.
  Primary source: [zstd CLI manual](https://github.com/facebook/zstd/blob/dev/programs/zstd.1.md).

### Required contract

A delta-capable client must:

1. hash the installed executable and match an exact supported source digest;
2. select a patch keyed by platform, architecture, source digest/version and
   target digest/version;
3. verify the downloaded patch digest;
4. produce a separate complete target temp without modifying the running EXE;
5. verify final target size/SHA-256;
6. fall back to compressed/full download on any mismatch or patch failure;
7. hand the verified raw temp to the existing Windows helper.

Patches must be generated from final release artifacts after icon embedding,
signing and every byte-changing build step. Rebuilding nominally the same
version is not an acceptable source unless its digest is identical.

### Version-matrix cost

For `P` platform binaries and direct patches from the latest `K` source
versions, each release needs up to `P × K` patch objects plus full fallbacks.
Today `P=4`; supporting three previous releases means up to 12 patch objects per
release. Supporting all nine recent binary releases means up to 36. Chaining
adjacent patches reduces publication count but makes skipped-version updates a
multi-download, multi-apply transaction with more failure and rollback states.

True delta therefore needs an explicit support window. It cannot replace the
full fallback while arbitrary old clients or locally different binaries must
remain updatable.

### Adoption gate

Do not choose an algorithm from reputation alone. In CI, generate gzip-full,
`bsdiff` and zstd `--patch-from` outputs from at least three consecutive pairs
of exact final artifacts for all platforms. Adopt true delta only if it produces
a material improvement over the ~35%-37% gzip transport ratio after accounting
for patch runtime, memory, generation time and Release complexity. A reasonable
planning gate is a median patch no larger than 25% of the gzip asset and a
verified full fallback; the exact threshold is a product decision.

## Platform Updater Alternatives

Microsoft documents that MSIX downloads only changed 64 KB blocks during
updates. It also requires MSIX packages to be signed with a valid, trusted code
signing certificate. This is a strong Windows-native answer only if the product
is willing to replace the current portable EXE/PowerShell install contract.

Primary sources:

- [MSIX overview](https://learn.microsoft.com/en-us/windows/msix/overview)
- [MSIX package signing](https://learn.microsoft.com/en-us/windows/msix/package/signing-package-overview)

Sparkle has official delta-update support, but it is a macOS application update
framework and would create a separate platform architecture rather than improve
the shared CLI updater.

Primary source: [Sparkle delta updates](https://sparkle-project.org/documentation/delta-updates/).

Neither option is recommended for the current cross-platform, single-executable
CLI boundary.

## Decision Sequence

Resolve these product decisions in order before revising the implementation
plan:

1. Must any previously released version continue to upgrade directly to the
   latest release?
2. Is adding compressed Release assets acceptable while retaining raw assets?
3. Should the first rollout cover all current platform binaries or Windows
   only?
4. Is resume required only within one TUI run, or across TUI restart/timeout?
5. Should true delta remain a benchmark-gated follow-up, and what patch-size
   threshold justifies its permanent matrix/runtime cost?
