# Progress, Diagnostics, and Secret Logging

## Channels

- TUI mutations emit structured progress through an `onProgress` callback.
  The parent view projects the latest active instruction into the shared
  `Spinner` overlay; core/service code must not print directly.
- CLI commands write normal output to stdout and usage/errors to stderr.
- Background update checks update state silently; they do not print into the
  OpenTUI renderer.
- Windows deferred helpers may write a diagnostic log in `%TEMP%`, but must not
  expose credentials or raw target/temp paths.

## Progress Events

Progress records should carry a level, user-facing message, optional component
id, and an optional `instruction` containing the concrete command or operation
currently running. Use stable levels such as `info`, `success`, `warning`, and
`danger`; do not parse display glyphs back into state.

The TUI busy overlay projects only `instruction`. Status messages remain useful
for CLI diagnostics but must not replace the command shown to a user while a
mutation is running.

The overlay is not a retained log: a newer progress event replaces the current
instruction, a completed operation removes it, and the parent emits one final
completion or cancellation toast. Diagnostic history belongs in typed results
and error detail, not in a bottom-of-page component.

The final success state must come from the operation result or postflight facts,
not from the presence of a success-looking progress message.

## Redaction

Never log or interpolate:

- Claude `ANTHROPIC_AUTH_TOKEN` values or arbitrary provider env secrets.
- Codex bearer tokens, `auth.json` token values, or raw profile TOML.
- MCP credentials embedded in URLs, args, headers, env or env files.
- Full secret-bearing JSON/TOML source in parse errors.

Use the domain redactor before calling `friendlyError`, toast, progress, CLI
formatters, or helper-script generators. Tests must include a sentinel secret
and assert it is absent from every output channel.

## Good and Bad

```ts
// Good: stable message plus redacted diagnostic.
return {ok: false, error: redactCodexTomlForOutput(message)};

// Bad: leaks the source document and credentials.
console.error('invalid profile', rawToml, error);
```

Direct `console.log` is allowed in CLI/build/verification scripts, not in a TUI
action path while the renderer owns stdout.
