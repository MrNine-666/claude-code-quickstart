# Provider Configuration Safety Contract

## Scenario: Mutating Claude and Codex provider profiles

### 1. Scope / Trigger

当 `tui/src/core/`、`services/`、CLI command 或 Provider View 中的代码读取、写入、列出、激活、编辑或删除 Claude Provider JSON 或 Codex profile TOML 时适用。它防止 credential/config 静默丢失，并保持 TUI、CLI 与 storage 行为一致。

### 2. Signatures

```ts
type JsonFileReadResult<T> =
  | {status: 'missing'}
  | {status: 'valid'; value: T}
  | {status: 'invalid'; error: string};

type ProviderServiceResult<T> =
  | {ok: true; data: T; warning?: string}
  | {ok: false; error: string; errorKind?: 'conflict'};

type CodexProfileScanResult = {
  profiles: readonly CodexProfileListItem[];
  failures: readonly {key: string; reason: string}[];
};

type CodexProviderUiTerm = '供应商'; // 仅 presentation，不是 protocol rename

atomicWrite(path, content, {mode?: number}): void;
writeJsonAtomic(path, value, {mode?: number}): void;
```

TUI add 必须使用 Claude `conflictStrategy: 'error'`，或执行等价的 Codex
`codexProfileExists(key)` check。Edit 针对当前 key，并可原子覆盖该 profile。

### 3. Contracts

- Claude profile 保持 settings-compatible 的单层 `{env}` JSON file。
- Codex profile 保持 `<key>.config.toml`；`key`、顶层 `model_provider`、唯一的
  `[model_providers.<key>]` table 与 table `name` 必须一致。
- Add 只检查请求的 target filename。同一 builtin family 中另一个明确 filename
  （例如 `glm-2.json`）不应阻止添加 `glm.json`。
- TUI add 绝不 increment 或覆盖已有 target。Edit 覆盖当前编辑的 profile；
  rename-to-existing 仍然是 error。
- Claude/Codex 同 target add failure 带 `errorKind: 'conflict'`。`ProviderForm`
  用 `toast.error` 渲染该 kind，清除 stale inline error 并保持 form 打开；
  validation 与 parse failure 仍显示 inline。
- 缺失的 mutable config 可以创建。已有 invalid `settings.json`、`.claude.json`、
  `config.toml` 或 profile 绝不能被当成 empty document 覆盖。
- Profile 保存成功但 activation/onboarding/default sync 失败时，返回 `ok: true`
  加 warning；刷新 list，但不要报告完整 success。
- ccq 写入的 Provider/config/auth file 在 POSIX 使用 `SECRET_FILE_MODE`（`0600`）。
  通用 atomic rewrite 保留已有 target mode，并沿用新建 non-secret file 的历史默认值。
- TUI 或 CLI 暴露的 TOML/JSON error output 必须脱敏，不得包含 token 或 source
  content。
- TUI/CLI user-facing copy 对 Claude 与 Codex entity 都直接使用“供应商”，不添加
  `Codex` 前缀。Agent context 通过 header、`--tool` 或 command context 传达。内部
  `CodexProfile*` symbol、`<key>.config.toml`、`codex --profile` 与 TOML
  `profile/profiles` field 保留 protocol name。

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Add target 已存在 | `ok: false`、`errorKind: 'conflict'`；显示 error toast、保持 form 打开、原 profile byte 不变 |
| Add target 缺失但 sibling builtin filename 存在 | 正常保存请求的 target |
| 编辑当前 profile | 原子替换 current profile；不执行 add conflict handling |
| 重命名编辑指向已有 target | 拒绝；两个 file 不变 |
| `settings.json` 缺失 | 创建 activation 所需最小 document |
| `settings.json` invalid/non-object 或 `env` non-object | Profile/settings mutation 前拒绝 |
| `.claude.json` invalid | 保留 profile save 与 file byte，返回 onboarding warning |
| Profile 已保存但 activation/config sync 失败 | `ok: true`、saved data 存在、warning 存在 |
| 一个 Codex profile invalid | 返回其他 profile 加 `official`，并加入脱敏 failure |
| Codex raw TOML 有 legacy selector、额外 Provider table、identity mismatch 或 forbidden auth field | 写入前拒绝 |
| POSIX secret file 写入 | 最终 mode 为 `0600` |
| TUI/CLI 展示 Codex entity | 显示“供应商”；不得显示 `Codex 供应商`、`Codex profile` 或 `Codex provider` 作为业务 entity |

### 5. Good / Base / Bad Cases

- 良好：存在 `glm-2.json`，用户添加 filename `glm`；创建 `glm.json`。
- 基线：用户编辑 `glm`；覆盖 `glm.json`，若 active 则重新同步 owned env key。
- 错误：用户添加 filename `glm` 但 `glm.json` 已存在；拒绝，不生成 `glm-3.json`，
  也不触碰 onboarding/settings。
- 良好：被拒绝的 add 显示 error toast，保留编辑后的 form value，允许修改 filename。
- 错误：解析损坏 file 时 fallback 到 `{}`，再写回。
- 良好：逐个扫描 Codex profile，并将 failure 发送到 `ErrorPanel`/CLI stderr，
  同时保持 valid row 可用。
- 良好：显示 `编辑供应商`，但 help 仍记录字面命令 `codex --profile <name>`。
- 错误：翻译 user-facing terminology 时 rename `CodexProfile`、`.config.toml` 或
  `--profile`。

### 6. Tests Required

使用临时 `CCQ_HOME`；绝不读取或修改开发者真实 home。

- 断言 Claude/Codex 同 target add rejection 保留原 byte；断言 edit 替换 current
  profile。
- 断言 Claude custom/builtin 与 Codex duplicate-add service result 携带
  `errorKind: 'conflict'`，ProviderForm 将其路由到 `toast.error` 且不调用
  `onSaved`。
- 断言 sibling builtin filename 不造成 false conflict，且不创建隐式 increment file。
- 断言 invalid JSON/TOML 在 mutation attempt 后逐字节不变。
- 断言 active Claude edit 删除旧 owned env key，但保留无关 user env。
- 断言 saved-but-not-activated result 包含 warning，且 saved profile 仍列出。
- 断言 mixed valid/corrupt Codex scan 保留 valid profile，并脱敏 failure/TUI/CLI output。
- POSIX 断言 Provider、settings/config、onboarding 与 auth file 为 `0600`；Windows
  断言写入成功。
- 运行 `bun scripts/verify-provider-safety.mjs`、`bun run typecheck` 与
  `bun run verify`。
- 断言 user-facing string literal 不包含 `Codex 供应商`、`Codex profile(s)` 或
  `Codex provider`，并断言 `codex --profile` 仍在 CLI help 中。

### 7. Wrong vs Correct

#### Wrong

```ts
const config = readJsonFile(path, {}); // 将 corrupt 与 missing 混为一谈
addProvider({...payload});             // default increment/overwrite 泄漏到 TUI
```

#### Correct

```ts
const config = readJsonFileStrict(path);
if (config.status === 'invalid') throw new Error('配置损坏，请先修复');

const result = addProvider({...payload, conflictStrategy: 'error'});
// Service 将已有 target result 映射到 errorKind: 'conflict'。
// ProviderForm 显示 toast.error(result.error)，并保持 form 打开。
// Edit 使用 editProvider(currentKey, updates)，而不是 addProvider。

// UI 文案：“供应商”。Protocol symbol 保持 CodexProfile / --profile。
```
