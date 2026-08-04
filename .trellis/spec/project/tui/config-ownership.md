# Configuration and Contract Ownership

## 1. Scope / Trigger

当变更读取、写入、预览、推荐、迁移或内嵌 Claude/Codex 配置、Provider profile、MCP definition、Skills 或规则文件时适用。

## 2. Signatures and Owners

| Domain | Canonical paths | Owner |
|---|---|---|
| Claude Provider | `~/.claude/providers/<name>.json`，`settings.json` 中的 owned env | Provider core/service/view |
| Codex Provider（供应商） | `~/.codex/<key>.config.toml`、`~/.codex/config.toml`、`auth.json` | Codex core/service/Provider view |
| Claude 通用配置 | `~/.claude/settings.json` 中的 owned field | Config core/service/view |
| Codex 通用配置 | `~/.codex/config.toml` 中的 owned TOML path | Codex config core/Config view |
| Claude MCP runtime（运行时） | `~/.claude.json.mcpServers` | MCP core/service/view |
| Codex MCP runtime（运行时） | `~/.codex/config.toml [mcp_servers]` | MCP core/service/view |
| MCP definition vault（定义库） | `~/.ccq/mcp-meta.json` | MCP vault/core |
| 全局规则 | `~/.claude/CLAUDE.md`、`~/.codex/AGENTS.md` | Prompts core/service/view |
| Skills | 官方 Skills CLI 以及 `.agents/skills`、`.claude/skills` 事实 | Skills core/service/view |
| TUI contract（契约） | `tui/contracts/**` | `core/contracts.ts`、embedded map |
| 安装 contract | `installer/contracts/**` | 仅 installer |

## 3. Contracts

- 一个 View 拥有一个数据领域。Config 绝不编辑 Provider、MCP、Skills 或 rule content。切换 Provider 绝不编辑 hooks/statusLine/permissions。
- Claude 与 Codex Provider protocol 保持分离；只共享 UI component 与 service result pattern。
- Structured JSON/TOML parser 拥有写入权。支持 TOML editor 时必须保留无关 field/comment。
- Recommended config import 是 fill-missing，不得覆盖 user value。
- Dirty editor 必须阻止 context/menu switch，直到用户 save 或 discard。已有 malformed file 必须展示，但不得覆盖。
- Runtime 消费的 TUI asset 在 `embedded-contracts.ts` 中以 `text` import；source mode 读取 `tui/contracts/`，compiled mode 读取 embedded map。不得提供 `CCQ_CONTRACTS_DIR` override。
- `providers.json`、`mcp-servers.json`、`claude-config.json`、`codex-config.toml` 与 rule template 都会内嵌。仅存在磁盘上的 contract file 仍是 CI/source input，不得假设它们位于 executable 旁边。

## 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| 通用配置保存中存在 Provider/MCP/Skills/rules | 保留每个非 owned domain |
| 推荐导入遇到已有用户值 | 保留已有 value |
| 已有格式错误的 JSON/TOML | 拒绝 save/import；保留字节 |
| Editor 脏状态时切换上下文 | 要求 save/discard/cancel 决策 |
| compiled executable 旁无 contract file | 加载 embedded content |
| embedded contract key 缺失或格式错误 | 以具名 contract error 失败 |
| View 直接解析 home/config path | 违反架构；移入 core/service |

## 5. Good / Base / Bad Cases

- 良好：导入 Codex recommendation 只添加缺失的 `model_reasoning_effort`，不动
  Provider、MCP 与 user hooks。
- 基线：缺失 rules file 以 empty 打开，只在 save/import 时创建。
- 错误：Config 用缩减后的 view model 序列化整个 `settings.json`，丢掉
  `statusLine` 或 Provider env。
- 错误：Compiled executable 调用 `readFileSync('tui/contracts/...')`。

## 6. Tests Required

- 按需运行 `verify-config-view.mjs`、`verify-config-rules-reuse.mjs`、
  `verify-provider-safety.mjs`、`verify-mcp-*.mjs`、`verify-contracts.mjs` 与
  `verify-compiled-contracts.mjs`。
- 加入 sentinel user-owned field，断言结构保持不变。
- Embedded change 同时加入 source-mode 与 compiled-mode contract probe。

## 7. Wrong vs Correct

```ts
// 错误：view 拥有 path，并重写整份外部 document。
writeFileSync(join(home, '.claude', 'settings.json'), JSON.stringify(form));

// 正确：view 将已验证的 text/options 交给 owning service。
const result = configService.saveGeneralConfig(text);
```
