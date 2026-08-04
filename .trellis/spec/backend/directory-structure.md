# Runtime Directory and Ownership Structure

## Current Layout

```text
tui/src/
├── index.tsx              # argv 路由、non-TTY guard、OpenTUI bootstrap
├── cli/                   # 命令解析、help、confirmation、exit code
├── core/                  # 存储格式、contract、命令、pure/domain logic
├── services/              # 面向 UI 的编排与友好结果映射
├── state/                 # pure reducer state 与 shortcut projection
├── hooks/                 # App/view 生命周期集成
├── views/                 # input dispatch 与 rendering composition
├── components/            # 可复用 OpenTUI 控件
└── config/keybindings.ts  # 物理按键绑定；唯一事实来源
```

`tui/contracts/` 拥有 TUI runtime 配置与模板。运行时加载的 JSON/TOML/Markdown
必须经过 `core/contracts.ts` 和 embedded-contract map；view 不得自行解析
contract 路径。

## Ownership Rules

- `cli/` 解析原始 token，并将 domain result 映射为 stdout/stderr/exit code。
  它必须调用现有 core/service function，不得重新实现行为。
- `core/` 拥有精确文件格式、validation、filesystem mutation、external command
  builder 与 typed domain result。
- `services/` 协调多步骤 view action，并将技术失败映射为可恢复的用户结果。
  它不得发明第二套 persistence model。
- `state/` reducer 保持纯函数。不得读取文件、spawn process、显示 toast 或修改
  cache。
- `views/` 拥有聚焦后的 input dispatch 与 render state。文件写入和命令执行
  必须留在 services/core 后方。
- `components/` 是可复用控件；它们不了解 Provider/MCP/Skills 业务规则。

## Adding a Feature

优先复用这些边界形成垂直切片：

```text
argv/key event -> parser or view -> service -> core contract -> filesystem/CLI
                                    ↓
                              typed result/progress
                                    ↓
                              reducer/view/CLI output
```

不要把 `utils` 当作杂物目录。共享逻辑应放在它所拥有的 contract 附近，例如
`toml-edit.ts`、`fs-utils.ts`、`tools-lifecycle.ts` 或 `skills-storage.ts`。

## Forbidden Historical Layouts

- 不得恢复 `manage/`、`manage/source/`、`ManageCore.*`、`manage.js` 或
  installer-side TUI 业务逻辑。
- 不得恢复根 `contracts/`；installer 与 TUI contract 分别归各自 consumer。
- 不得在 view 中复制 registry array、managed field list 或 shortcut map。
