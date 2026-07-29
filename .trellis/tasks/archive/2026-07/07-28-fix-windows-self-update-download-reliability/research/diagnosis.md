# Windows TUI Self-Update Download Diagnosis

## Symptom

The TUI displays `0%` throughout the update download and later reports:

```text
The socket connection was closed unexpectedly
```

## Reproduction Facts

- Installed version: `2.4.1`
- Latest version: `2.4.2`
- Asset: `ccq-windows-x64.exe`
- Declared size: `109262848`
- SHA-256:
  `828147b2c3fa8d0ba8155708dc4d5da19f38a6560acf19a83cb63840e7f8cf46`
- Release URL:
  `https://github.com/MrNine-666/claude-code-quickstart/releases/download/v2.4.2/ccq-windows-x64.exe`

Calling the current `downloadUpdate()` against an isolated temp target produced
no progress beyond zero and returned a structured download error.

## Redirect Probe

With Bun 1.3.14:

```text
redirect 302 true
auto ERROR The operation was aborted.
direct PASS 206 1048576
direct-close PASS 206 1048576
```

Repeated automatic requests also produced socket-close, unable-to-connect and
timeout variants. The signed CDN URL returned 1 MiB ranges when requested
directly. TCP 443 and TLS succeeded against the CDN endpoints; GitHub Release
API checks also succeeded.

## Boundary Conclusion

The failure occurs at `await fetchAsset(plan.downloadUrl, ...)` before the first
response body chunk. `downloadUpdate()` reports zero before fetch and only
advances after writing chunks, which explains the persistent `0%`.

No Windows helper is started until the complete temp file passes size and
SHA-256 verification. The executable replacement path therefore cannot cause
this observed failure.

## Windows Lock Verification

Current runtime gate results:

```text
[PASS] Windows update helper: short lock retries and succeeds
[PASS] Windows update helper: long lock preserves old target and diagnostic temp
[PASS] Windows update helper: restart occurs only after verified success
```

The helper writes a ready marker before waiting for the parent process, retries
`File.Replace` 20 times at 250ms intervals after parent exit, verifies the new
target, restores the backup on postflight failure and starts the updated target
only after success.

## Root Cause

The strongest reproduced cause is Bun's automatic GitHub-to-CDN redirect path
under the current Windows/network environment. The current downloader has no
manual redirect control or partial transfer resume, so a transient failure
always discards progress and the transaction temp.

## Diagnostic Cleanup

The interrupted full-download probe left a stable 4,881,957-byte temp file. It
was verified not to be growing and its exact `ccq-direct-download-*` directory
was removed. No product file was modified during diagnosis.
