# Cross-Layer Thinking Guide

## Map the Flow

编辑前写出真实路径：

```text
key/argv -> parser/view -> service -> core/contract -> file or child process
         <- typed result/progress <- postflight facts <- mutation
         -> reducer reconciliation -> view/footer/CLI exit
```

Installer/Release 工作使用：

```text
source -> contract -> builder -> dist artifact -> CI/Release -> installed runtime
```

## Boundary Checklist

- [ ] 精确输入是什么，由谁验证？
- [ ] 哪一层拥有 persistence 或 process execution？
- [ ] 哪些 field/file 属于其他 domain，必须保留？
- [ ] Missing 与 corrupt state 是否区分？
- [ ] Exit code 后是否需要 filesystem/runtime postflight？
- [ ] 结果是否可能为 partial、restored、scheduled 或 cancelled？
- [ ] 哪些 side effect 需要 snapshot/atomic write/cleanup？
- [ ] Progress、error、toast 与 CLI output 中的 secret 如何脱敏？
- [ ] 最终 UI state 是否根据当前事实完成 reconciliation？

## Project-Specific Boundaries

### Config

Provider、Config、MCP、Skills 与 Global Rules 分别由不同 owner 管理。通用 config
save 不得用缩减后的 model 覆盖其他 domain。

### Shared Agent Resources

Tools/MCP/Skills 都展示两侧事实，但各自具有不同物理模型。不得在不同 domain
间复用 projection 或 injection 假设。

### External CLIs

Command construction、environment、timeout、TTY 与 diagnostic capture 都是
contract 的组成部分。Skills/CodeGraph/CcgWorkflow 官方命令还需要 postflight
fact；stdout/stderr 本身不是 state。

### Compiled Runtime

Bun 单文件 executable 中可能不存在 source path、dynamic worker 与相邻
contract file。每条 source-mode asset path 都需要 embedded/plain fallback
和 compiled smoke。

### Windows Release

Source PowerShell 与 `irm | iex` 具有不同 path/encoding context。Build
composition、contract、template 或 remote entry code 发生移动时，两种模式都要
测试。

## After the Change

- [ ] 边界两侧都有 focused assertion。
- [ ] Corrupt/partial/error 案例证明没有无关 mutation。
- [ ] Registry/help/footer/contract projection 仍共享一个事实来源。
- [ ] Source 与 compiled/platform-specific path 均已覆盖。
