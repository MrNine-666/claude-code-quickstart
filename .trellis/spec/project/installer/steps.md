# Windows Install Steps Contract

## 1. Scope / Trigger

适用于 `installer/windows/steps/**`、`installer/macos/steps/**`、
`installer/contracts/steps.json`、Windows Registry 回退以及调用这些步骤的
bootstrap 生命周期。

## 2. Step Signatures

活动步骤实现以下语义函数：

```powershell
Test-<StepId>Installed  # @{ IsInstalled; Version; Data; Message }
Install-<StepId>        # @{ Success; ErrorMessage; Data }
Verify-<StepId>         # @{ Success; ErrorMessage } (optional in practice)
```

支持更新的步骤还可以实现：

```powershell
Update-<StepId>         # @{ Success; ErrorMessage; Data; UpdatedItems = @() }
```

`Bootstrap.ps1` 同时接受这些 hashtable 结果和旧版 Boolean 返回值。新步骤应使用
hashtable 形状，以便摘要和测试仍可取得状态、版本、数据及技术错误。

## 3. Current Contract and Ownership

`installer/contracts/steps.json` 是跨平台唯一事实来源。Basic 严格包含两个活动步骤：

| StepId | Order | Dependencies | Windows | macOS |
|---|---:|---|---|---|
| `NodeJS` | 10 | 无 | `windows/steps/NodeJS.ps1` 加四个子模块 | `macos/steps/NodeJS.zsh` |
| `Git` | 20 | 无 | `windows/steps/Git.ps1` | `macos/steps/Git.zsh` |

两者都是必需步骤，已安装时跳过，且不是可选项。安装器随后提供 ccq 可执行文件；
Claude Code、Codex、Providers、MCP、Skills 和其他周边工具由 TUI 工具管理生命周期
负责，不属于安装器步骤。

`ClaudeCode.ps1` 仅作为历史参考保留。它不列在 `steps.json` 中，不由 Registry 回退
返回，也不得重新加入 Basic 安装流程。删除的 Ccline/CcgWorkflow/Mcp 安装器步骤
同样遵循此规则。

## 4. Active Step Behavior

### NodeJS

- 任意 provider 中已有版本足够的 `node`/`npm` 时直接复用；报告跳过，不迁移或清理。
- 版本不足时，若能安全检测到活动 provider（fnm/nvm/direct），就在原处修复。只有
  无法修复时才提供平台回退：Windows 使用 nvm-windows 或直接安装 Node.js，macOS
  使用官方 nvm 脚本。
- 绝不卸载 provider、重写 PATH 以清理另一个 provider，或在 provider 之间移动 npm
  全局包。
- 验证 `node --version` 和 `npm --version`；成功安装后配置既有 npm mirror 行为。

Windows NodeJS 实现拆分为 `NodeJS-Detect.ps1`、`NodeJS-Common.ps1`、
`NodeJS-Nvm.ps1` 和 `NodeJS-Direct.ps1`，必须由 `Get-StepFiles` 在
`NodeJS.ps1` 之前加载。

### Git

`Git.ps1` 通过既有 winget wrapper 安装，应用四项 Git 建议和 Git Bash UTF-8 wrapper
配置，然后验证 `git --version` 及预期的全局配置。

## 5. Adding or Changing a Step

1. 在 `installer/contracts/steps.json` 中新增或更新 StepId、平台文件路径、顺序、
   依赖、分组及 skip/update flags。
2. 能力同时支持两个平台时，实现两端 consumer；Windows 文件保持
   PS5.1/StrictMode 兼容。
3. 在 Windows Registry inline fallback 中登记相同 metadata，并保持一致性断言通过。
4. 将步骤加入针对性的合同和生命周期测试。不得从 README 或归档任务推断安装计划。
5. 步骤边界或结果形状变化时，更新相应 installer spec。

## 6. Validation Matrix

| Check | Expected result |
|---|---|
| `Test` 报告已安装 | 生命周期跳过，不重新安装或迁移 |
| `Test` 报告缺失 | 执行 Install，然后 Verify 必须通过 |
| 缺少依赖 | Registry 推导的依赖闭包在所选步骤前补充依赖 |
| 一个步骤失败 | 记录失败，向用户提供友好及技术细节，后续独立步骤遵循配置策略 |
| source contract 不可用 | 使用 Registry inline fallback 并检查一致性 |
| 发现旧 ClaudeCode 文件 | 保持历史状态，不消费该文件 |

## 7. Tests Required and Wrong vs Correct

运行：

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
```

修改共享步骤 metadata 时，还要运行 `zsh -n installer/macos/Install.zsh` 和 macOS
`--list-steps` probe。为每个新增依赖、回退分支和结果字段添加针对性测试。

```powershell
# 错误：只在过时 README 或一个平台文件中增加新的 Basic 步骤。
# 正确：同步修改 steps.json、两个受支持的 consumer、Registry fallback 以及合同/生命周期测试。
```
