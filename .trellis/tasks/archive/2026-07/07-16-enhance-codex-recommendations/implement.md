# Implementation Plan: Codex Recommended Configuration

1. Update `tui/contracts/codex-config.toml`.
   - Change `model_reasoning_effort` to `xhigh` and revise its explanation.
   - Add clearly labelled commented opt-in snippets for `network_access` and `memories`.
   - Do not add `notify`, absolute paths, provider fields, MCP fields, or desktop state.

2. Extend `tui/scripts/verify-config-view.mjs`.
   - Assert the annotated Codex recommendation exposes `xhigh` and documents both opt-in settings.
   - Assert `fillMissingIntoText(..., 'cx')` writes `model_reasoning_effort = "xhigh"` but does not write the commented enhancement tables.
   - Retain existing ownership, invalid-TOML, secret-redaction, and round-trip assertions.

3. Add shared TOML preview support.
   - Extend `CodePreviewFiletype` and its line-token dispatch in `tui/src/components/code-preview.tsx` with `toml`.
   - Implement display-only TOML tokens for table headers, keys, scalar values, punctuation and comments, including quoted-string-aware trailing-comment detection.
   - Reuse `jsonTokens`, `syntax`, and `colors.muted`; do not add a duplicate theme palette or depend on Tree-sitter.
   - Route only Codex read-only current-config and recommendation previews in `tui/src/views/ConfigView.tsx` to `filetype='toml'`; leave the editable textarea in its current text mode.

4. Extend visual regression gates.
   - Update `tui/scripts/verify-code-preview.mjs` with source-level guards for the TOML dispatch and comment/table/key tokenization path.
   - Update `tui/scripts/verify-config-view.mjs` to require TOML preview routing for both Codex preview surfaces while retaining the text-mode editor assertion.

5. Validate contract propagation and UI checks.
   - Run `bun run typecheck` in `tui/`.
   - Run `bun scripts/verify-code-preview.mjs`, `bun scripts/verify-config-view.mjs`, and `bun scripts/verify-compiled-contracts.mjs` in `tui/`.
   - Review the diff to ensure only the contract, focused verification, and Trellis task artifacts changed.

## Risks and Rollback

- Risk: treating opt-in snippets as active TOML would silently enable networking or a version-dependent feature. Mitigation: keep the snippets commented and assert they are absent from fill-missing output.
- Risk: TOML preview can diverge between source and compiled ccq when it relies on Tree-sitter. Mitigation: use the existing custom `CodePreview` path and no parser worker.
- Rollback: revert the contract value or remove an optional snippet. Existing users retain values already explicitly written to their own config.

## Execution Result - 2026-07-17

- 推荐契约使用 `xhigh`，联网与 memories 保持注释可选且不被 fill-missing 写入。
- Codex 当前/推荐预览已走共享 TOML `CodePreview`，可编辑 textarea 保持 text 模式。
- `verify-code-preview.mjs`、`verify-config-view.mjs`、`verify-compiled-contracts.mjs`、`bun run typecheck` 与 `bun run verify` 全部通过。
- 用户已授权完成并归档只剩验收的任务。
