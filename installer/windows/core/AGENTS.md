# installer/windows/core/ -- Windows runtime

本目录包含由 `installer/windows/Install.ps1` dot-source 的 PowerShell
5.1+ 基础库。它们不是 PowerShell module，不使用 `Export-ModuleMember`。

## 加载顺序

```text
Json.ps1 -> Ui.ps1 -> Process.ps1 -> Profile.ps1 -> Update.ps1
         -> Admin.ps1 -> Net.ps1 -> Registry.ps1 -> Bootstrap.ps1
```

职责依次覆盖 JSON 兼容层、终端 UI、外部命令与 ccq PATH、Profile 原子
编辑、更新快照、权限、网络、步骤注册表和生命周期调度。

## 必读规范

- [Windows core contract](../../../.trellis/spec/installer/windows-core.md)
- [Platform runtime](../../../.trellis/spec/installer/platform-runtime.md)
- [Build and release](../../../.trellis/spec/installer/build-release.md)
- [Windows steps](../../../.trellis/spec/installer/steps.md)

修改本目录时必须保持 PS5.1、StrictMode 数组安全、`$PSScriptRoot` 为空的
Release 执行边界，以及 Profile/ccq 的原子替换行为。具体函数签名、返回
形状、错误矩阵和验证要求统一以 Trellis spec 为准。

## 最小验证

```powershell
pwsh -File installer/contracts/Test-Contracts.ps1
pwsh -File installer/windows/Install.ps1 -ListSteps
pwsh -File installer/build.ps1
```
