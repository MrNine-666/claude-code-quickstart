### 环境特定（macOS / zsh / Homebrew）
- 默认 Shell 为 zsh；用户级初始化优先写入 `~/.zshrc` 和 `~/.zprofile`
- Homebrew 仅在 CCQ 执行官方安装成功后，按官方推荐追加 `eval "$(<brew路径> shellenv)"` 到 `~/.zprofile`
- 路径使用正斜杠 `/`，PATH 分隔符为 `:`
- Shell 命令中路径必须加双引号；CCQ 自身涉及 profile 写入时优先使用 CCQ 托管标记块
- Node.js 由 nvm 官方脚本管理；nvm 安装后必要时执行 `source ~/.zshrc` 或重新打开终端

### Windows 兼容提醒
本配置文件可被 Windows 与 macOS 共用；在 macOS 环境中不要建议 winget、注册表、MSI/EXE、Windows Terminal 或 PowerShell `$PROFILE` 作为主实现路径。

### 输出设置
- 中文响应；禁止截断输出
