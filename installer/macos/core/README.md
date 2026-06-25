# installer/macos/core

macOS zsh 运行时核心库。该目录只承载平台实现，不复制 Windows PowerShell 业务规则；步骤、供应商、MCP 和配置默认值从 `contracts/` 消费。

## 加载顺序

```zsh
source core/Ui.zsh
source core/Process.zsh
source core/Profile.zsh
source core/Platform.zsh
source core/PackageManager.zsh
source core/Json.zsh
source core/Registry.zsh
source core/Bootstrap.zsh
```

## 状态语义

`Bootstrap.zsh` 使用实时检测，不写持久化安装状态。生命周期状态包含：

- `Pending`
- `Running`
- `Success`
- `Failed`
- `Skipped`
- `Unsupported`
- `ManualRequired`

`Unsupported` 与 `ManualRequired` 用于平台或上游限制，不计为成功。
