# Manage Shell and View Contract

## 1. Scope / Trigger

Apply to App shell navigation, Agent context, menu/view composition, Config and
Global Rules reuse, list/detail/form modes, theme and embedded editors.

## 2. Signatures and Stable Shape

```ts
type AgentContext = 'cc' | 'cx';
type ManageModuleId = 'tools' | 'provider' | 'config' | 'prompts' | 'mcp' | 'skills';
type Focus = 'nav' | 'header' | 'view' | 'form' | 'modal';
```

Left navigation order is fixed:

```text
工具管理 -> 供应商 -> 配置文件 -> 全局规则 -> MCP -> Skills
```

## 3. Contracts

- Default context is Claude Code. Visible context labels are the full
  `Claude Code` / `Codex`, never `cc` / `cx`.
- Provider, Config and Global Rules show the Agent Header and reuse the same UI
  while core/services switch storage protocols.
- Tools, MCP and Skills are shared two-sided views and hide the Header without
  reserving a row. They preserve the retained context for later modules.
- App owns the dynamic footer. Views report their current submode; physical keys
  and display labels derive from the keybinding/shortcut registries.
- App owns the `shouldExit` UI state but delegates execution through its
  `onExit` prop. Renderer destruction and `process.exit` belong to the
  entrypoint lifecycle; App must not wait for background effects to settle.
- Every domain uses list/detail/form/confirm modes with shared components. A
  destructive action always enters a strong confirmation state.
- Config and Global Rules use preview, `e` edit, recommendation and fill-missing
  import semantics. Dirty edits require save/discard/cancel before navigation.
- Global Rules target `~/.claude/CLAUDE.md` or `~/.codex/AGENTS.md`. General
  Config excludes those files and every Provider/MCP/Skills domain.
- Multiline editing uses `TextareaEditor`/OpenTUI textarea and obeys the no
  scrollbox rule. Search/filter uses `SingleLineInput`.
- Theme values come from semantic tokens. Do not encode terminal background
  assumptions or hardcode a second dark-only palette in a view.

## 4. Validation & Error Matrix

| Condition | Required behavior |
|---|---|
| Switch Agent on Header | Preserve menu order; reload current exclusive domain |
| Enter Tools/MCP/Skills with stale header focus | Coerce focus to view; retain context value |
| Top row Up in shared view | Stay/cycle according to view contract; never enter hidden Header |
| Modal active | Background inactive; only Modal draft changes |
| Quit from an exit-capable focus | App reports `onExit`; entrypoint restores the terminal and exits 0 |
| Dirty editor + navigation/context change | Prompt save/discard/cancel |
| Existing rule/config malformed | Show error/detail; do not overwrite |
| Missing file | Empty preview/editor; create only on save/import |
| Narrow terminal/long content | Stable regions remain; text clips/wraps without overlap |

## 5. Good / Base / Bad Cases

- Good: switch from Claude Config to Codex Config with the same preview/edit
  model while the service changes JSON vs TOML ownership.
- Base: a missing AGENTS.md displays an empty rule preview.
- Bad: adding a seventh Codex menu or filtering shared Tools by Header context.
- Bad: hardcoding `Ctrl+T` text inside a view while keybindings use another key.

## 6. Tests Required

- `verify-manage-tui-state.mjs`, `verify-agent-context.mjs`,
  `verify-shortcuts.mjs`, layout gates and domain view gates.
- `verify-manage-tui-state.mjs` also covers App-to-entrypoint quit wiring and
  renderer-cleanup-before-process-exit ordering.
- Config/Rules changes run `verify-config-view.mjs`,
  `verify-config-rules-reuse.mjs`, `verify-prompts-view.mjs`.
- Input changes use real OpenTUI render/input tests where cursor, selection,
  paste, undo or focus ownership is involved.

## 7. Wrong vs Correct

```tsx
// Wrong: view owns a duplicate footer and path decision.
<ShortcutBar shortcuts={[{key: 'e', label: '编辑'}]} />

// Correct: view reports a mode; App derives shortcuts from the registry.
useEffect(() => onSubModeChange(mode), [mode, onSubModeChange]);
```
