# Changelog

## Unreleased

### Changed

- Manage 模块统一到 Node.js：Provider / Skills / Update 迁移为共享 JS 管理器，MCP 继续复用既有 `mcp-manager.js`，面向用户的 `ccq`、`Manage.ps1`、`Manage.zsh` 入口与菜单行为保持不变。

### Notes

- Manage JS 集合通过 `manage.ps1` / `manage.sh` 内嵌 base64 部署到 `~/.ccq/scripts/`，源码模式可从 `installer/contracts/scripts/*.js` fallback。
- 完全离线调试请使用源码入口：`pwsh installer/windows/Manage.ps1` 或 `zsh installer/macos/Manage.zsh`；需要远端资源的 Skills 安装/更新、Update 检查与部分 MCP 操作仍需网络。
