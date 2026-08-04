# MCP Vault and Runtime Contract

## 1. Scope / Trigger

适用于 MCP 合同解析、表单、vault 存储、Claude/Codex runtime 写入、共享列表投影、启用/禁用/删除与凭据处理。

## 2. Signatures and Stores

```text
Definition vault: ~/.ccq/mcp-meta.json
Claude runtime:   ~/.claude.json -> mcpServers
Codex runtime:    ~/.codex/config.toml -> [mcp_servers]
Contract source:  tui/contracts/mcp-servers.json
```

Core 入口位于 `mcp-contract.ts`、`mcp-form.ts`、`mcp-config-builder.ts`、`mcp-vault.ts`、`mcp.ts`；TUI 编排位于 `mcp-service.ts` 与 `views/mcp/**`。

## 3. Contracts

- Server id 是稳定 identity，创建后不得重命名。
- Vault 拥有可复用 definition/credential/metadata，不拥有 activation。Activation 从每个 Agent runtime file 的实时内容派生。
- Shared list projection 是 vault definition、Claude runtime id 与 Codex runtime id 的并集，按 id 去重。它对 runtime file 只读；已有 runtime definition 可备份到 vault。
- Claude 与 Codex 的启用/禁用操作只通过 Agent-specific builder/parser 修改所选 runtime file。
- Vault 中历史 `disabled` field 不是 activation truth，并在 cleanup/migration
  时移除。
- 内置表单来自 MCP contract。Custom input 按 transport（`stdio`/`http`）与 credential type 结构化；不要保存以后还需重新解析的 shell command string。
- Secret 可按要求存入 vault/runtime，但所有 preview、error、progress event 与 CLI output 都必须脱敏。
- MCP operation 不再生成或更新 `~/.claude/rules/ccq-mcp-*.md`。

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| 无效/不安全的 server id | 在 Vault/runtime 写入前拒绝 |
| Add id 已存在 | 进入编辑/显式冲突处理；绝不隐式 duplicate |
| 已有格式错误的 runtime file | 拒绝 mutation，保留字节 |
| Vault entry 缺失但 runtime id 存在 | 展示 runtime row；可选择备份 definition |
| Vault 标记 `disabled` 但 runtime 含 id | Runtime 为 active；清理历史 field |
| 启用一个 Agent | 另一个 Agent runtime 保持不变 |
| Credential 解析/构建失败 | 不写入；返回脱敏 error |
| Env-file credential type | 保持当前只读行为，除非新 contract 改变它 |

## 5. Good / Base / Bad Cases

- 良好：一个 id 只出现一次，同时显示独立的 Claude/Codex toggle fact。
- 基线：即使没有 bundled catalogue entry，runtime-only custom server 仍可管理。
- 错误：从 `mcp-meta.json.disabled` 推导 activation。
- 错误：因为隐藏的 Global Header 恰好保存一个 context value，就写入两个 Agent
  file。

## 6. Tests Required

- `verify-mcp-parity.mjs`、`verify-mcp-template.mjs`、`verify-mcp-multitool.mjs`、
  `verify-mcp-shared-projection.mjs`、`verify-mcp-official.mjs` 与相关 shortcut/state
  gate。
- 覆盖 corrupt file、duplicate id、两个 Agent direction、optional header、
  URL/arg secret redaction 与无关 TOML/JSON preservation。

## 7. Wrong vs Correct

```ts
// 错误：vault metadata 成为 activation truth。
const active = !vault.servers[id].disabled;

// 正确：从每侧 runtime configuration 计算状态。
const status = computeSharedStatus(vault, claudeRuntime, codexRuntime);
```
