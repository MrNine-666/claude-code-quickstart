# Configuration and Contract Ownership

## 1. Scope / Trigger

Apply whenever a change reads, writes, previews, recommends, migrates or embeds
Claude/Codex configuration, Provider profiles, MCP definitions, Skills or rule
files.

## 2. Signatures and Owners

| Domain | Canonical paths | Owner |
|---|---|---|
| Claude Provider | `~/.claude/providers/<name>.json`, owned env in `settings.json` | Provider core/service/view |
| Codex Provider | `~/.codex/<key>.config.toml`, `~/.codex/config.toml`, `auth.json` | Codex core/service/Provider view |
| General Claude config | Owned fields in `~/.claude/settings.json` | Config core/service/view |
| General Codex config | Owned TOML paths in `~/.codex/config.toml` | Codex config core/Config view |
| Claude MCP runtime | `~/.claude.json.mcpServers` | MCP core/service/view |
| Codex MCP runtime | `~/.codex/config.toml [mcp_servers]` | MCP core/service/view |
| MCP definition vault | `~/.ccq/mcp-meta.json` | MCP vault/core |
| Global rules | `~/.claude/CLAUDE.md`, `~/.codex/AGENTS.md` | Prompts core/service/view |
| Skills | official Skills CLI plus `.agents/skills`, `.claude/skills` facts | Skills core/service/view |
| TUI contracts | `tui/contracts/**` | `core/contracts.ts`, embedded map |
| Install contracts | `installer/contracts/**` | installer only |

## 3. Contracts

- One view owns one data domain. Config never edits Provider, MCP, Skills or
  rule content. Switching a Provider never edits hooks/statusLine/permissions.
- Claude and Codex Provider protocols remain separate; only UI components and
  service result patterns are shared.
- Structured JSON/TOML parsers own writes. Preserve unrelated fields/comments
  where the TOML editor supports them.
- Recommended config import is fill-missing. It must not overwrite user values.
- A dirty editor must block context/menu switching until the user saves or
  discards. A malformed existing file must be shown but not overwritten.
- Runtime-consumed TUI assets are imported as `text` in
  `embedded-contracts.ts`; source mode reads `tui/contracts/`, compiled mode
  reads the embedded map. No `CCQ_CONTRACTS_DIR` override.
- `providers.json`, `mcp-servers.json`, `claude-config.json`,
  `codex-config.toml` and rule templates are embedded. Disk-only contract files
  remain CI/source inputs and must not be assumed present beside the executable.

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| General config save with Provider/MCP/Skills/rules present | Preserve every non-owned domain |
| Recommended import with existing user value | Keep existing value |
| Existing malformed JSON/TOML | Reject save/import; preserve bytes |
| Context switch while editor dirty | Require save/discard/cancel decision |
| Compiled executable without contract files on disk | Load embedded content |
| Embedded contract key absent or malformed | Fail with named contract error |
| View directly resolves home/config path | Architectural violation; move to core/service |

## 5. Good / Base / Bad Cases

- Good: importing Codex recommendations adds missing `model_reasoning_effort`
  while leaving Provider, MCP and user hooks untouched.
- Base: a missing rules file opens as empty and is created only on save/import.
- Bad: Config serializes all of `settings.json` from a reduced view model and
  drops `statusLine` or Provider env.
- Bad: a compiled executable calls `readFileSync('tui/contracts/...')`.

## 6. Tests Required

- `verify-config-view.mjs`, `verify-config-rules-reuse.mjs`,
  `verify-provider-safety.mjs`, `verify-mcp-*.mjs`, `verify-contracts.mjs` and
  `verify-compiled-contracts.mjs` as applicable.
- Include sentinel user-owned fields and assert structural preservation.
- Include source-mode and compiled-mode contract probes for embedded changes.

## 7. Wrong vs Correct

```ts
// Wrong: view owns paths and rewrites a whole foreign document.
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(form));

// Correct: view passes validated text/options to the owning service.
const result = configService.saveGeneralConfig(text);
```
