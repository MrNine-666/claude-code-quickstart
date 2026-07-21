# Design — CLI 命令契约与工具更新一致性

## 1. Parser Contract

启动类命令在供应商名之后没有 ccq 自有 flag，因此双横线的唯一作用是移除第一个分隔符：

    input:  ["-p", "hi", "--", "--verbose"]
    output: ["-p", "hi", "--verbose"]

算法保持纯函数：

    index = rest.indexOf("--")
    if index < 0: return rest
    return rest.slice(0, index) + rest.slice(index + 1)

不能使用 rest.slice(index + 1)，因为它正是当前静默丢参的根因；也不能 filter 全部双横线，因为后续双横线可能是底层工具字面参数。

## 2. Help Contract

parseCli 负责保留用户输入，helpFor 负责查询：

    help                -> {kind:"help"}
    help cc             -> {kind:"help", verb:"cc"}
    help unknown        -> {kind:"help", verb:"unknown"}

runCli 对 helpFor 返回 null 的情况输出未知子命令和总帮助，退出码 1。VERBS 仅用于路由已实现命令，不用于抹掉用户输入。

## 3. Tool Registry

扩展现有 ToolDefinition：

    type ToolDefinition = {
      ...
      readonly cliAliases?: readonly string[];
    }

解析规则：

1. 对输入做 trim + lower-case。
2. 先匹配 definition.id 的 lower-case。
3. 再匹配 cliAliases。
4. 帮助/错误列表直接遍历 TOOL_DEFINITIONS。

不创建第二个完整工具表；短别名只附着在 owning definition。这样新增第 9 个工具时，检测、安装、CLI 解析和帮助集合不会再次漂移。

## 4. Force Refresh Boundary

detectComponents 已提供 forceRefresh 参数：

    detectComponents(onProgress?, forceRefresh?)

CLI 的显式 update 传 true；TUI 检测 cache 与 r 手动刷新语义不改。CLI 仍通过 selectUpdateTargets 和 updateComponents 复用既有业务逻辑。

## 5. Testability

- parseCli/parsePassthrough 继续纯函数测试。
- 工具 resolver 导出为纯函数并接收 readonly definitions 时可完整断言。
- runToolsUpdate 通过注入 detect/update 函数或提取 orchestration seam 断言 forceRefresh，不调用真实 npm。
- runCli 使用 console capture 断言 stdout/stderr/退出码。

## 6. Compatibility and Rollback

- 只恢复被错误删除的参数，不改变常规调用。
- 所有现有 alias 迁入 definitions 后保持兼容。
- 强制刷新只发生于明确的 tools update 动作，网络成本是已确认策略。
- parser、registry、force refresh 可分三个小步独立回滚。
