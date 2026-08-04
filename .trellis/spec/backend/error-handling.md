# Error Handling Contract

## Expected Failure Shapes

调用方需要按可恢复失败分支时，使用 discriminated result：

```ts
type OperationResult<T, E> =
  | {readonly ok: true; readonly data: T; readonly warning?: string}
  | {readonly ok: false; readonly error: E};
```

现有示例包括 `CheckLatestVersionResult`、`DownloadUpdateResult`、
`ApplySelfUpdateResult`、Provider service result 与 Skills adoption result。
不得把 `partial`、`restored`、`scheduled`、`applied` 和 `deleted` 压缩成一个
`boolean success` 字段。

## File Read Rules

缺失与损坏是不同状态。缺失的可变文件可以创建；已有但格式错误的 JSON/TOML
文件必须保留并报告。

```ts
const result = readJsonFileStrict(path);
if (result.status === 'invalid') return {ok: false, error: result.error};
```

绝不能捕获 parse error、用 `{}` 替代原值后再写回。原子写入使用
`fs-utils.ts`/`toml-edit.ts`，保留无关字段，并在 POSIX 上对机密文件使用
`0600`。

## Child Process Rules

- 捕获式管理命令使用 `core/exec.ts`，并始终检查 `code`、`stdout`、`stderr`、
  timeout 与 spawn failure。
- 启动类 `cc`/`cx` 命令继承 stdio，并返回 child code。
- 启动 Agent 时出现 ENOENT，exit code 为 `127`。
- 即使 descendant 仍持有 stdio handle，timeout 也必须让 caller settle。
- 命令 exit code 是诊断，不是 filesystem fact 的证明。Skills、MCP、tool
  injection 与 self-update 必须对最终状态进行 reconciliation。

## Presentation

- TUI 默认错误应友好且简洁；技术细节放入 `ErrorPanel` 和 `D` 展开路径。
- CLI 错误写入 stderr；适用时保持 stdout 可被机器读取。
- 格式化 JSON/TOML 或 child stderr 前使用领域 redactor。
- 第一步成功但 activation 失败时，只要已保存对象仍可用，就返回带 warning 的
  success。

## Cleanup

只有主要 typed result 已携带失败且 cleanup 不会改变该结果时，best-effort
cleanup 才可使用范围狭窄的空 `catch`。该 catch 必须只覆盖当前 transaction 的
temp/helper path。绝不能吞掉 primary operation error。

## Error Matrix

| Condition | Required behavior |
|---|---|
| 可选文件缺失 | 返回 `missing` 或创建最小 owned structure |
| 已有文件格式错误 | 拒绝 mutation；保留原字节；脱敏输出 |
| 外部命令 non-zero | 友好错误，并保留诊断 |
| 命令为 zero 但 postflight fact 缺失 | 返回 failure/partial，绝不返回 success |
| Mutation 已完成但后续 sync 失败 | 数据仍可用时返回带 warning 的 success |
| Non-TTY 中执行 destructive action 且无 `--yes` | mutation 前拒绝 |
| Primary failure 后 cleanup 也失败 | 保留 primary error；不得扩大删除范围 |

## Scenario: Abortable Child Operations

### 1. Scope / Trigger

当 TUI mutation 可被父 view 中断时使用此合同，尤其是命令由 Windows shell
process tree 承载时。

### 2. Signatures

```ts
type ExecOptions = {
  readonly timeout?: number;
  readonly cwd?: string;
  readonly env?: NodeJS.ProcessEnv;
  readonly signal?: AbortSignal;
};

function execCommand(
  command: string,
  args: readonly string[],
  options?: ExecOptions
): Promise<ExecResult>;

function bindExecSignal(signal: AbortSignal): typeof execCommand;
```

### 3. Contracts

- `signal` abort 时，`execCommand` 立即以 `OperationAbortedError`（`name:
  'AbortError'`）reject；不得等待 `close`。
- Abort 会终止完整 child process tree（Windows 使用 `taskkill /T /F`，其他
  平台使用 signal termination），移除 settlement listener 与正常 timeout；
  在 child close 前可保留 force-kill cleanup timer。
- Service 通过现有 dependency seam 传递绑定后的 executor；不得创建第二个
  process runner。
- Parent view 抑制过期 completion dispatch、清除 busy state，并在 cancel 后
  刷新 detection fact。

### 4. Validation & Error Matrix

| Condition | Required result |
|---|---|
| Spawn 前 signal 已 aborted | 立即返回 `AbortError`，不执行命令 |
| 命令执行中 signal abort | 立即返回 `AbortError`，并请求终止 process tree |
| Abort/timeout 后 descendant 仍持有 stdio | Caller promise 已 settle |
| 已 abort 的 mutation promise 后续 settle | Parent 忽略 success/failure dispatch |
| Cancel 后 final fact refresh 失败 | 保留 cancellation state；通过正常 detection state 展示 refresh failure |

### 5. Good / Base / Bad Cases

- 良好：`ToolsView`/`SkillsView` 每次 mutation 拥有一个 controller，并在
  `finally` 中调用 `finish(signal)`。
- 基线：非 mutation 的 detection command 不传 `signal`，保持现有
  timeout/error 语义。
- 错误：捕获 `AbortError` 后 dispatch `item-failed`/`action-failed`，或把已
  cancel 命令的 partial stdout 当作 success。

### 6. Tests Required

- `verify-core-functions.mjs`：timeout 与真实 AbortSignal 测试断言立即 settle
  和 error name。
- Domain reducer gate：断言 `cancel-busy` 清除 busy/progress/error state。
- Tool/Skills lifecycle gate：断言 cancel mutation 后仍以 postflight fact
  refresh 作为最终状态来源。

### 7. Wrong vs Correct

```ts
// 错误：operation layer 拥有 UI cancellation 语义。
try {
  await execCommand(command, args, {signal});
} catch {
  dispatch({type: 'item-failed', error: '取消'});
}

// 正确：core reject typed cancellation；父级拥有 reducer policy。
const exec = bindExecSignal(signal);
try {
  await serviceMutation(exec);
} catch (error) {
  if (!signal.aborted) dispatch({type: 'item-failed', error: friendlyError(error)});
}
```
