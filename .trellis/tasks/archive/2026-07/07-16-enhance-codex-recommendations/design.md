# Design: Codex Recommended Configuration

## Boundary

The existing `tui/contracts/codex-config.toml` remains the sole recommendation contract. It is statically imported by `tui/src/core/embedded-contracts.ts`, exposed through `tui/src/core/codex-config.ts`, and displayed by `ConfigView` through `config-service`.

No new runtime state, external command, or platform-specific detection is introduced.

## Recommendation Tiers

### Base settings

The uncommented TOML assignments stay the only values parsed by `loadRecommendedDocument()` and written through the existing `RECOMMENDED_KEY_PATHS` fill-missing loop. `model_reasoning_effort` changes from `medium` to `xhigh`; all other current base settings retain their present values and ownership.

### Opt-in enhancements

The contract will append commented TOML snippets for:

- `[sandbox_workspace_write]` with `network_access = true`
- `[features]` with `memories = true`

Comments make these examples visible in the recommendation preview but invisible to the TOML parser. Therefore Ctrl+O continues to apply only base settings without a new UI flow or a second recommendation contract. Users who choose an enhancement copy or enter it in the editor deliberately.

## Ownership and Safety

`CODEX_UNMANAGED_KEYS` continues to protect provider and MCP data. The enhancement examples must not broaden that list or change save merging. `notify` is omitted because its current implementation is machine- and platform-specific.

## TOML Preview

`CodePreview` is the shared read-only renderer already used for JSON configuration and Markdown rules. Extend its filetype union with `toml` and add a line-oriented TOML tokenizer. `ConfigView` passes `toml` only to its read-only Codex current-config preview and Codex recommendation side panel; the editable textarea remains `text` because it has no bundled, compiled-runtime-safe TOML grammar.

The tokenizer is display-only and must not call the TOML parser. It recognizes the common configuration shapes used by Codex:

- table and array-table headers (`[section]`, `[[section]]`)
- keys before `=` including quoted keys
- quoted strings, numbers, booleans, arrays and punctuation
- comments beginning with `#`, including trailing comments outside quoted strings

It reuses the existing JSON token palette and muted/comment styles rather than adding a separate theme schema. This keeps dark/light themes synchronized and avoids duplicating preview infrastructure. The implementation must preserve the existing selectable text nodes, line-number behavior, newline normalization, and long-line layout rules.

Tree-sitter is deliberately not used: compiled ccq executables already disable its worker, while `CodePreview` works identically in source and compiled modes.

## Data Flow

`codex-config.toml` -> static text import -> `EMBEDDED_CONTRACTS` -> `loadTextContract()` -> recommendation preview and TOML parse -> existing fill-missing writer.

Only uncommented base assignments reach the parse/write branch. Commented opt-in examples stop at the preview branch.

For visual rendering, `ConfigView` -> `CodePreview(filetype: 'toml')` -> display-only TOML tokens. This branch never reaches `toml-edit.ts` or the configuration writer.

## Compatibility and Rollback

Commented TOML is valid TOML and is already rendered as text in the Codex configuration view. If a recommended value proves unsuitable, revert only the contract line; no user configuration needs migration because fill-missing never overwrites existing values.
