# Progress, Diagnostics, and Secret Logging

## Channels

- TUI mutation 通过 `onProgress` callback 发出结构化进度。Parent view 将最新的
  active instruction 投影到共享 `Spinner` overlay；core/service code 不得直接
  print。
- CLI command 将正常输出写入 stdout，将 usage/error 写入 stderr。
- 后台 update check 静默更新 state；不得向 OpenTUI renderer print。
- Windows deferred helper 可以在 `%TEMP%` 写 diagnostic log，但不得暴露
  credential 或原始 target/temp path。

## Progress Events

Progress record 应携带 level、用户可见 message、可选 component id，以及一个
可选 `instruction`，用于描述当前正在运行的具体 command 或 operation。使用
`info`、`success`、`warning`、`danger` 等稳定 level；不得从 display glyph
反向解析 state。

TUI busy overlay 只投影 `instruction`。Status message 可用于 CLI diagnostic，
但 mutation 运行时不得替代向用户显示的 command。

Overlay 不是持久日志：新 progress event 替换当前 instruction，operation 完成后
移除它，parent 只发出一个最终 completion 或 cancellation toast。Diagnostic
history 属于 typed result 与 error detail，不属于页面底部 component。

最终 success state 必须来自 operation result 或 postflight fact，而不是来自
看起来像成功的 progress message。

## Redaction

绝不能记录或插值：

- Claude `ANTHROPIC_AUTH_TOKEN` 值或任意 Provider env secret。
- Codex bearer token、`auth.json` token 值或原始 profile TOML。
- 嵌入 URL、arg、header、env 或 env file 的 MCP credential。
- Parse error 中包含机密的完整 JSON/TOML source。

调用 `friendlyError`、toast、progress、CLI formatter 或 helper-script generator
前使用领域 redactor。测试必须包含 sentinel secret，并断言每个 output channel
都不包含它。

## Good and Bad

```ts
// 良好：稳定 message 加脱敏 diagnostic。
return {ok: false, error: redactCodexTomlForOutput(message)};

// 错误：泄漏 source document 与 credential。
console.error('invalid profile', rawToml, error);
```

CLI/build/verification script 中允许直接 `console.log`；TUI action path 在
renderer 拥有 stdout 时不得使用。
