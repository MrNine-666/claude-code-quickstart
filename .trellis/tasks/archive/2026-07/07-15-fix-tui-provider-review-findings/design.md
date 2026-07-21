# Design — TUI 供应商模块安全与一致性修复

## 1. Scope and Boundaries

修复沿现有边界落位，不让 React 视图直接处理文件系统：

```text
ProviderView / ProviderForm
        ↓ 结构化结果（success / partial warning / error）
provider-service / codex-service
        ↓
provider.ts / codex.ts / provider-form.ts / codex-provider-form.ts
        ↓
fs-utils.ts / toml-edit.ts / paths.ts
        ↓
~/.claude/* 与 ~/.codex/*
```

不统一 Claude JSON provider 与 Codex TOML profile 的业务模型；只复用异常结果、严格读取和安全原子写入的基础能力。

## 2. Strict JSON Read Before Mutation

### 2.1 New read result

在 `fs-utils.ts` 新增不影响现有调用方的严格读取函数，例如：

```ts
type JsonFileReadResult<T> =
  | {status: 'missing'}
  | {status: 'valid'; value: T}
  | {status: 'invalid'; error: string};
```

现有 `readJsonFile(path, fallback)` 保持行为，避免 Tools、MCP、Update 等宽松读取路径发生隐式变化。所有“即将写回原文件”的供应商路径改用严格结果。

### 2.2 Mutation semantics

- `settings.json` missing：以 `{}` 创建。
- `settings.json` valid object：保留非供应商字段后更新。
- `settings.json` invalid 或顶层非 object：抛出脱敏、可操作错误，目标字节不变。
- `.claude.json` missing：创建 `{hasCompletedOnboarding:true}`。
- `.claude.json` invalid：不写入；profile 保存继续成功，并产生 onboarding warning。

错误只包含逻辑路径（`~/.claude/settings.json`）和解析类别，不拼接原文。

## 3. Provider Ownership Cleanup

`editProviderUnlocked` 在任何修改前记录：

```ts
const previousOwnedKeys = new Set(Object.keys(profile.env ?? {}));
```

`switchProviderUnlocked` 增加仅供内部调用的 `additionalCleanupKeys`，最终清理集合为：

```text
所有当前 provider.env 键
∪ previousOwnedKeys
∪ 契约定义的受管模型键
```

然后写入新 profile 的 token、base URL、模型键和 extra env。这样删除最后一个拥有某键的 profile 值时仍能清理 settings，同时不把用户全局 env 纳入供应商所有权。

## 4. Conflict Policy

用户已确认 TUI 业务策略：新增拒绝同名，编辑正常覆盖当前 profile。

- Claude `saveProviderForm` add 无论 builtin/custom 都显式传 `conflictStrategy:'error'`；Codex `saveCodexProviderForm` add 在写盘前检查同名 `<key>.config.toml`。
- 文件名存在时返回带 `errorKind:'conflict'` 的结构化错误，保留原文件；`ProviderForm` 使用 error toast 提示并保持表单打开，用户可直接填写新的唯一文件名。其他校验错误仍使用表单错误区。
- edit 分支继续调用 `editProvider(currentKey, updates)`，对当前 profile 原子覆盖，不复用 add 冲突判断。
- Core 的 `increment` / `overwrite` 策略保留给明确使用它们的非 TUI 调用方，避免无关 API 破坏。

冲突校验必须在构造/写入目标文件前完成；失败不得修改 onboarding、settings 或原 profile。

## 5. Secure Atomic Writes

为 `fs-utils.atomicWrite` / `writeJsonAtomic` 增加可选写入参数，而不是改变所有调用方默认值：

```ts
type AtomicWriteOptions = {mode?: number};
const SECRET_FILE_MODE = 0o600;
```

实现要求：

1. 临时文件创建时使用指定 mode。
2. rename 后在 POSIX 再校正目标 mode，避免既有文件或平台 rename 差异。
3. 失败时继续清理临时文件。
4. Windows 不以 mode 作为成功条件。

`toml-edit.atomicWrite` 透传相同选项。供应商敏感调用点显式传 `SECRET_FILE_MODE`：Claude provider/settings/.claude.json 与 Codex profile/config/auth。非敏感 Prompts、cache、snapshot 等保持原默认。

## 6. Structured Partial Success

扩展 service 成功分支为可选 warning：

```ts
type ProviderServiceResult<T> =
  | {ok: true; data: T; warning?: string}
  | {ok: false; error: string};
```

- Claude add：profile 保存成功但 onboarding 或 activate 失败时返回 `ok:true` + warning，保留 `activated:false`。
- Codex add：profile 保存后 set-default 失败时同样返回 partial warning，不把已保存文件伪装为完全失败。
- `ProviderForm` 将成功数据/警告传给 `onSaved`。
- `ProviderView` 总是 refresh；有 warning 时显示 warning toast，没有时才显示原 success toast。

warning 必须描述“已保存、未激活”和下一步，不包含底层配置文本或 token。

## 7. Codex Profile Validation and Default Import

### 7.1 Separate clear/import sets

```ts
const CODEX_PROVIDER_CLEAR_KEYS = [
  'model', 'model_provider', 'model_providers', 'profile', 'profiles'
];
const CODEX_PROVIDER_IMPORT_KEYS = [
  'model', 'model_provider', 'model_providers'
];
```

设默认时先按 CLEAR 删除旧痕迹，再只按 IMPORT 导入。这样无论 profile 文件内容如何，ccq 都不会重新生成 legacy selector。

### 7.2 Save boundary validation

`saveCodexProfileToml` 在写盘前调用单一验证器：

- 顶层不得含 `profile` / `profiles`。
- `model_provider` 必须等于文件 key。
- `model_providers` 只能包含当前 key table。
- table `name` 必须与 key 一致（可规范化或给出错误；计划采用明确错误，避免静默改写 raw TOML）。
- table 不得含 `env_key` / `auth` / `requires_openai_auth`。
- 允许 `base_url`、`experimental_bearer_token`、`wire_api`、headers 等合法自定义扩展。

验证错误统一经过 `redactCodexTomlForOutput`，保存前失败不修改 profile/config。

## 8. Resilient Codex Scan

新增详细扫描结果，不用异常表示单文件损坏：

```ts
type CodexProfileScanResult = {
  profiles: CodexProfileListItem[];
  failures: {key: string; reason: string}[];
};
```

- 每个 `<key>.config.toml` 独立 try/catch。
- official 虚拟条目始终加入有效 profiles。
- reason 只保留脱敏解析摘要。
- `listCodexProfiles()` 可保留兼容包装，返回 `scanCodexProfiles().profiles`；TUI service 与 CLI 使用详细结果以展示 warnings。
- `ProviderDisplayData` 增加可选 `loadFailures`，ProviderView 复用 `ErrorPanel`，不新增第二套错误组件。

CLI `ls` 继续输出有效项；失败集合写 stderr。只要扫描本身可完成，不因单文件损坏丢失全部结果。

## 9. Test Strategy

新增或扩展真实临时目录测试：

- Claude 严格 JSON：missing / valid / invalid / non-object。
- 活跃 edit 删除 extra env 与受管模型键。
- Claude/Codex 同名 builtin/custom add 均拒绝，edit 仍更新当前 profile。
- partial success：profile 存在、settings 不变、warning 正确。
- Codex raw TOML legacy/auth/多 provider 拒绝及合法扩展保留。
- Codex 混合 valid + corrupt 扫描，TUI service/CLI 脱敏输出。
- POSIX 权限断言；Windows 条件跳过 mode 数值断言但仍验证写入。

测试 token 使用固定无意义占位符，失败消息断言“不包含占位符”。

## 10. Compatibility, Risk, and Rollback

- 严格读取会把过去的“损坏文件自动当空文件覆盖”改成显式失败，这是有意的安全行为变化。
- TUI 同名 add（内置与自定义）统一改为 error，不再自动递增或静默 overwrite；正常 edit 与显式非 TUI core 策略仍兼容。
- 现存含 legacy/禁用字段的 Codex profile 在下次 TUI 保存时会被拒绝，但文件不会自动修改；用户可按错误提示手工清理。
- `0600` 只作用于供应商敏感调用点，不改变通用写盘调用方。
- 每一组变更可按实现步骤独立回滚；不包含一次性数据迁移，因此回滚不需要恢复用户文件格式。

## 11. User-facing Terminology Boundary

- Presentation boundary（TUI/CLI strings）：Claude Code 与 Codex 的业务实体都直接显示“供应商”；Agent 区分由 Header、`--tool` 或命令上下文承担，不显示“Codex 供应商”。
- Protocol boundary（types/files/commands/TOML）：保留 `CodexProfile*`、`<key>.config.toml`、`codex --profile` 与 legacy `profile/profiles` 字段原名。
- 验证同时断言用户文案不再出现 `Codex profile`、`Codex provider` 或 `Codex 供应商`，并保留 CLI 帮助中的字面量 `codex --profile`，避免把术语统一误做成协议重命名。
