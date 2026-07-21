# MCP Vault and Runtime Contract

## 1. Scope / Trigger

Apply to MCP contract parsing, forms, vault storage, Claude/Codex runtime writes,
shared list projection, enable/disable/delete and credential handling.

## 2. Signatures and Stores

```text
Definition vault: ~/.ccq/mcp-meta.json
Claude runtime:   ~/.claude.json -> mcpServers
Codex runtime:    ~/.codex/config.toml -> [mcp_servers]
Contract source:  tui/contracts/mcp-servers.json
```

Core entry points live in `mcp-contract.ts`, `mcp-form.ts`,
`mcp-config-builder.ts`, `mcp-vault.ts`, `mcp.ts`; TUI orchestration lives in
`mcp-service.ts` and `views/mcp/**`.

## 3. Contracts

- Server id is the stable identity. It cannot be renamed after creation.
- The vault owns reusable definitions/credentials/metadata, not activation.
  Activation is derived live from each Agent runtime file.
- Shared list projection is the union of vault definitions, Claude runtime ids
  and Codex runtime ids, deduplicated by id. It is read-only with respect to
  runtime files; existing runtime definitions may be backed up into the vault.
- Claude and Codex enable/disable operations mutate only the selected runtime
  file through the Agent-specific builder/parser.
- Historical `disabled` fields in the vault are not activation truth and are
  removed during cleanup/migration.
- Built-in forms come from the MCP contract. Custom input is structured by
  transport (`stdio`/`http`) and credential type; do not store a shell command
  string that must later be reparsed.
- Secrets may be stored in the vault/runtime as required, but every preview,
  error, progress event and CLI output is redacted.
- MCP operations no longer generate/update `~/.claude/rules/ccq-mcp-*.md`.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Invalid/unsafe server id | Reject before vault/runtime write |
| Add id already exists | Enter edit/explicit conflict behavior; never implicit duplicate |
| Existing malformed runtime file | Reject mutation and preserve bytes |
| Vault entry absent, runtime id present | Show runtime row; optionally back up definition |
| Vault says disabled but runtime contains id | Runtime is active; clean historical field |
| Enable one Agent | Other Agent runtime remains unchanged |
| Credential parse/build fails | No write; redacted error |
| Env-file credential type | Preserve current read-only behavior unless a new contract changes it |

## 5. Good / Base / Bad Cases

- Good: one id appears once with independent Claude/Codex toggle facts.
- Base: a runtime-only custom server remains manageable even without a bundled
  catalogue entry.
- Bad: deriving activation from `mcp-meta.json.disabled`.
- Bad: writing both Agent files because a hidden global Header happens to hold
  one context value.

## 6. Tests Required

- `verify-mcp-parity.mjs`, `verify-mcp-template.mjs`,
  `verify-mcp-multitool.mjs`, `verify-mcp-shared-projection.mjs`,
  `verify-mcp-official.mjs` and the relevant shortcut/state gates.
- Include corrupt files, duplicate ids, both Agent directions, optional headers,
  URL/args secret redaction and unrelated TOML/JSON preservation.

## 7. Wrong vs Correct

```ts
// Wrong: vault metadata becomes activation truth.
const active = !vault.servers[id].disabled;

// Correct: compute each side from its runtime configuration.
const status = computeSharedStatus(vault, claudeRuntime, codexRuntime);
```
