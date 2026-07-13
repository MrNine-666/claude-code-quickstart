# MCP 页：http 可选 header + Codex TOML 编辑改造计划

> 生成时间：2026-07-10
> 分支：main
> 类型：复杂任务（契约 + core 表单模型 + service 保存链 + McpFormView 交互 + 测试）
> 状态：待确认

## 一、目标

修复 MCP 页两个问题：

1. **context7 / exa 的可选 API key 没有可填入口**
   - 二者是官方 remote HTTP（`McpType: http` + `CredentialType: none`，免 key 匿名可用，正因免 key 才 `Recommended: true`）。
   - 官方 key 通过 **HTTP header** 传递，不是 env、也不是 url-embedded：
     - context7 → header `CONTEXT7_API_KEY`
     - exa → header `x-api-key`
   - 现状：模板只生成 `{type:'http', url}`，用户看不到可填 key 的位置，`Note` 字段也没被当作凭据提示显示。
   - **本期范围仅 context7 + exa**（用户确认），其它 http MCP（deepwiki/figma）不动。

2. **Codex MCP 应以 TOML 语法编辑，而非 JSON**
   - 底层保存链已正确：`persistCodexMcpServer → writeCodexMcpServer`（经 `toCodexMcpConfig` 转 TOML 写 `~/.codex/config.toml` `[mcp_servers.<id>]`）+ 备份到 vault（`~/.ccq/mcp-meta.json`，即用户所说的「统一管理 mcp 的 json」）。
   - 问题只在**编辑界面**：`McpFormView` 对 cc/cx 一律用 JSON textarea，Codex 用户看到 JSON 花括号不符合 TOML 心智。
   - 用户确认：**cx 上下文用 TOML 语法编辑框**（模板 + 编辑区都是 TOML），保存时解析 TOML → config → 走既有 cx 保存链（config.toml + vault）。

## 二、已验证事实

### 保存/加载链
- `saveMcpServer(serverId, json, agentContext)`（`services/mcp-service.ts:80`）
  → `parseMcpFormInput`（JSON 专用，`core/mcp-form.ts:177`）
  → `persistMcpServer`（`core/mcp.ts:588`，按 agentContext 分派 cc/cx）。
- **核心 bug**：`parseMcpFormInput`（`mcp-form.ts:192-198`）对 http 只返回 `{type, url}`，**丢弃 headers**；且 `McpConfigEntry`（`core/mcp-config-builder.ts:7-13`）类型无 `headers` 字段。→ 即使模板带出 header 占位，保存后也会消失，必须一并修。
- `toCodexMcpConfig`（`core/mcp-codex-schema.ts`）白名单已含 `http_headers` / `bearer_token_env_var`，Codex 侧 header 透传已支持（`scripts/verify-mcp-official.mjs:62-73` 已测）。
- cx 编辑框的 config 结构应与 JSON 版对称（编辑 config 本身，不含 `[mcp_servers.<id>]` 外层）：
  ```toml
  url = "https://mcp.exa.ai/mcp"

  [http_headers]
  x-api-key = ""
  ```

### 契约与内嵌
- 契约走内嵌：`core/embedded-contracts.ts:10` `import mcp-servers.json with {type:'text'}`；改 `contracts/mcp-servers.json` 即生效（构建时内嵌）。
- context7/exa 当前契约块：`McpType:'http'` + `CredentialType:'none'` + `Note`（可选 key 说明）。

### TOML 能力
- `core/toml-edit.ts` 提供 `parse` / `stringify`（基于 `smol-toml ^1.7.0`），可用于 cx 模板生成与实时校验。

### 模板/表单
- `getMcpTemplateJson`（`mcp-form.ts:94`）：http → `{type:'http', url, env?}`；`collectCredentialHint` 从 `Credentials/ArgsCredentials/Token*` 拼「凭据获取」提示（未读 header 类）。
- `McpFormView`（`views/mcp/McpFormView.tsx`）：add 模式模板 radio + Server ID + JSON textarea；实时校验用 `parseMcpJsonFormat`；保存 `saveMcpServer(id, jsonText, agentContext)`。**不区分 agentContext**。
- `McpView`（`views/mcp/McpView.tsx:127,205`）：add 传 `configToJson(null)`，edit 传 `configToJson(detail.config)`。

### 官方 header 依据
- Context7：`headers.CONTEXT7_API_KEY`（[官方配置](https://www.mintlify.com/upstash/context7/mcp/configuration)）。
- Exa：`x-api-key` header（[Exa MCP 源码](https://github.com/exa-labs/exa-mcp-server/blob/main/api/mcp.ts)）。

## 三、改造方案

### Phase 1 — 契约：为 context7/exa 声明可选 header 凭据

`contracts/mcp-servers.json`，给 context7/exa 增加**可选 header 凭据**元数据（不改 `CredentialType: none`，保持匿名可用与 Recommended 语义）：

```jsonc
"context7": {
  ...,
  "CredentialType": "none",
  "OptionalHeaders": [
    {
      "HeaderName": "CONTEXT7_API_KEY",
      "Label": "Context7 API Key（可选，提高频次/私有库）",
      "Secret": true,
      "Url": "https://context7.com/dashboard"
    }
  ]
},
"exa": {
  ...,
  "CredentialType": "none",
  "OptionalHeaders": [
    {
      "HeaderName": "x-api-key",
      "Label": "Exa API Key（可选，提高频次）",
      "Secret": true,
      "Url": "https://dashboard.exa.ai/api-keys"
    }
  ]
}
```

- 新增字段 `OptionalHeaders?: McpHeaderField[]`（`HeaderName/Label/Secret?/Url?`），在 `core/mcp-contract.ts` 的 `McpServerDefinition` 声明类型。
- 选 KISS 的独立字段而非扩展 `CredentialType`：可选 header 与现有 required 凭据语义不同，塞进 `Credentials` 会污染 required 校验。

### Phase 2 — core：http config 支持 headers + 模板带出 header 占位

`core/mcp-config-builder.ts`：`McpConfigEntry` 增加 `headers?: Record<string, string>`。

`core/mcp-form.ts`：
- `parseMcpFormInput` http 分支**保留 headers**（修 bug）：
  ```ts
  const config: McpConfigEntry = {type: 'http', url: raw.url};
  const headers = normalizeEnv(raw.headers); // 复用 normalizeEnv（string→string 规整）
  if (headers) config.headers = headers;
  ```
- `getMcpTemplateJson` http 分支：读 `OptionalHeaders` 带出 `headers: {HeaderName: ''}` 占位。
- `collectCredentialHint`：追加 `OptionalHeaders` 的 `Label: Url`，让「凭据获取」提示显示 key 申请地址。

### Phase 3 — core：Codex TOML 模板 + 解析

`core/mcp-form.ts` 新增 TOML 侧对称函数（与 JSON 版并列）：
- `getMcpTemplateToml(serverId): {toml, credHint} | null`
  - 复用 `getMcpTemplateJson` 得到 config 对象 → `toCodexMcpConfig`（去 type、白名单）→ `stringify`（toml-edit）。
  - http 带 `OptionalHeaders` 时输出 `[http_headers]` 段占位（Codex 用 `http_headers`）。
- `configToToml(config): string`：编辑回显用（config → toCodexMcpConfig → stringify）。
- `parseMcpTomlFormat(toml)`：`parse` 包装，返回 `{ok,value}|{ok:false,error}`（对齐 `parseMcpJsonFormat`）。
- `parseMcpFormInputToml(serverId, toml)`：校验 serverId + parse TOML → 复用 http/stdio 判定逻辑产出 `McpFormPayload`（http 保留 `http_headers`；判定与 JSON 版共享内部函数，避免重复）。

`services/mcp-service.ts`：`saveMcpServer` 按 agentContext 选择解析器（cx → `parseMcpFormInputToml`，cc → `parseMcpFormInput`）。`extractEnvCredentials` 对 cx 也需从 `http_headers`/`env` 收集 credentials 备份到 vault。

### Phase 4 — McpFormView：按 agentContext 切 JSON/TOML 编辑

`views/mcp/McpFormView.tsx`：
- 由 `agentContext` 派生 `isToml = agentContext === 'cx'`。
- 模板应用 / 编辑回显 / 实时校验 / textarea 标题文案按 `isToml` 走 TOML 分支（模板 `getMcpTemplateToml`，校验 `parseMcpTomlFormat`，标题「配置 TOML」）。
- textarea 键位、缩进、复制等复用现有 `textarea-edit-keys`（与语法无关）。

`views/mcp/McpView.tsx`：
- add：cx 传 `''`（空 TOML），cc 传 `configToJson(null)`。
- edit：cx 传 `configToToml(detail.config)`，cc 传 `configToJson(detail.config)`。

### Phase 5 — 测试

- `scripts/verify-mcp-template.mjs`：
  - context7/exa 模板（cc JSON）含 `headers` 占位键；credHint 含 key 申请地址。
  - `parseMcpFormInput` 保留 headers（回归 bug）。
- `scripts/verify-mcp-official.mjs`：契约 `OptionalHeaders` 存在性断言（context7=`CONTEXT7_API_KEY`，exa=`x-api-key`）。
- 新增/扩展 cx TOML 路径断言：`getMcpTemplateToml('exa')` 输出含 `url` + `[http_headers]`；`parseMcpFormInputToml` 解析 http_headers 正确；`configToToml` 回显不含 `type`。
- `scripts/verify-mcp-multitool.mjs`：确认 cx 保存后 config.toml 与 vault 的 header 备份。

## 四、影响范围

| 层 | 文件 | 改动 |
|----|------|------|
| 契约 | `contracts/mcp-servers.json` | context7/exa 加 `OptionalHeaders` |
| 类型 | `core/mcp-contract.ts` | `McpHeaderField` + `OptionalHeaders` |
| 类型 | `core/mcp-config-builder.ts` | `McpConfigEntry.headers` |
| core | `core/mcp-form.ts` | 修 parse 保留 headers；模板带 header；新增 TOML 模板/解析函数 |
| service | `services/mcp-service.ts` | saveMcpServer 按 agentContext 选解析器；credentials 收集含 headers |
| view | `views/mcp/McpFormView.tsx` | isToml 分支（模板/校验/文案） |
| view | `views/mcp/McpView.tsx` | add/edit 按 agentContext 传 JSON/TOML |
| 测试 | `scripts/verify-mcp-{template,official,multitool}.mjs` | header + TOML 断言 |

## 五、不做范围

- 不改 context7/exa 的 `CredentialType`（保持 `none` 匿名可用 + Recommended）。
- 不给 deepwiki/figma 等其它 http MCP 加 header 占位。
- 不改 Codex 底层写盘链（`persistCodexMcpServer`/`writeCodexMcpServer` 已正确），仅改编辑界面语法。
- 不改 vault 结构与 cc 的 `.claude.json`/`settings.json` 写入逻辑。

## 六、风险

- `smol-toml` `stringify` 对嵌套表（`[http_headers]`）的输出格式需实测（模板生成后能被 `parse` 往返）；Phase 3 先写往返测试兜底。
- TOML 空模板（add 自定义）应为 `''` 而非 `{}`；`parseMcpFormInputToml` 需容忍空文本给出「stdio 需 command / http 需 url」的既有错误语义。
