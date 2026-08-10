# Claude Code 指定配置启动方式调研

调研日期：2026-08-10

## 结论

Claude Code **没有官方的供应商/profile 简写**。当前官方 CLI 对单次会话加载额外配置只提供：

```text
--settings <file-or-json>
```

它没有 `-s` 短参数，也没有与 Codex `--profile` 对应的 `--profile`、供应商名称或配置别名参数。因此，对于 ccq 当前保存为单个 JSON 文件的 Claude Code 供应商配置，官方支持的直接启动方式仍是：

```powershell
claude --settings ~/.claude/providers/custom.json
```

这里的 `~` 是 PowerShell 对用户主目录的展开，不是 Claude Code 提供的新简写；它只是比 `"$HOME/.claude/providers/custom.json"` 更短。官方文档明确允许 `--settings` 接收文件路径，因此展开后的绝对路径符合该契约。

## 官方契约

### `--settings`

官方 CLI 参考说明，`--settings` 接收以下任一形式：

- settings JSON 文件路径；
- 内联 JSON 字符串。

该参数为当前会话加载额外 settings；对应字段会覆盖 settings 文件中的值，未提供的字段仍沿用其他 settings 来源。官方参考表只列出 `--settings`，没有为它列出短参数或 profile/alias 形式。

来源：

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code settings](https://code.claude.com/docs/en/settings)

本机安装的官方 Claude Code `2.1.226` 的 `claude --help` 也只列出：

```text
--settings <file-or-json>  Path to a settings JSON file or a JSON string to load additional settings from
```

同一份帮助中没有 `-s`、`--profile` 或 provider selector。这项本机检查用于核对当前发行版行为；正式契约以上述官方文档为准。

### `CLAUDE_CONFIG_DIR` 不是等价简写

官方提供 `CLAUDE_CONFIG_DIR` 来改写默认的 `~/.claude` 配置目录，主要用于隔离配置或并行使用多个账号。但它切换的是**整个配置根目录**，不仅是单个 settings 文件：settings、会话历史、插件都会放到该目录；Linux 和 Windows 的凭据也在其中，macOS 凭据则保存在系统 Keychain。

因此它可以构造独立 Claude Code 环境，但不能直接指向 ccq 的 `~/.claude/providers/custom.json`，也不是无副作用的供应商文件简写。若采用它，目标必须是包含完整 Claude 配置布局的目录，例如其中应有 `settings.json`。

来源：

- [Claude Code environment variables: `CLAUDE_CONFIG_DIR`](https://code.claude.com/docs/en/env-vars)
- [Debug your Claude Code configuration](https://code.claude.com/docs/en/debug-your-config)

### 其他相近参数也不能替代

- `--setting-sources <sources>` 只筛选要加载的内置来源 `user`、`project`、`local`，不能按任意供应商文件名选择配置。
- `--add-dir` 增加 Claude 可访问的工作目录；即使配合 `CLAUDE_CODE_ADDITIONAL_DIRECTORIES_CLAUDE_MD=1`，它也只是让附加目录中的 `CLAUDE.md`/rules 被加载，不会把 JSON 当作供应商 settings。
- 官方 CLI 没有 `.env` 文件选择参数。供应商所需环境变量可以来自 settings 的 `env` 字段或调用 shell，但这不提供按供应商名称切换的官方 profile 机制。

来源：

- [Claude Code CLI reference](https://code.claude.com/docs/en/cli-reference)
- [Claude Code memory](https://code.claude.com/docs/en/memory)
- [Connect Claude Code to an LLM gateway](https://code.claude.com/docs/en/llm-gateway-connect)

## README 建议

README 中应把 Claude Code 示例缩短为：

```powershell
claude --settings ~/.claude/providers/custom.json
```

不要写成 `claude --profile custom`、`claude -s ...` 或暗示 Claude Code 内建供应商别名；这些都不属于当前官方 CLI 契约。若还需要缩到单个短命令，只能由 ccq 或用户的 shell function/alias 提供，那将是项目/用户自定义能力，不应标注为 Claude Code 官方用法。
