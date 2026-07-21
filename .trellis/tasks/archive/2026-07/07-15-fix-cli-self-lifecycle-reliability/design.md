# Design — CLI 与 ccq 自生命周期可靠性父任务

## 1. Task Topology

父任务只维护共享需求、业务策略、跨子任务依赖与最终集成验收，不作为主要实现目标。

    07-15-fix-cli-self-lifecycle-reliability
      ├─ 07-15-fix-cli-command-contracts
      │    CLI parser/help/tool registry/cache
      └─ 07-15-harden-ccq-self-lifecycle
           self-update transaction/Windows helper/self-uninstall/OpenTUI restart

两个子任务可分别完成红灯回归与实现，但最终合并顺序固定为 CLI 契约先稳定、生命周期子任务后接入帮助和入口，最后由父任务做编译产物级集成验收。

## 2. Shared Boundaries

### Presentation boundary

- cli/argv.ts 只解析 token，不访问文件系统或网络。
- cli/commands 负责调用 core、输出 stdout/stderr 和返回退出码。
- app.tsx 只维护确认、下载、应用和重启 UI 状态，不实现文件替换。

### Core boundary

- core/update.ts 保留既有公开自更新入口并承载 Release 检查/事务应用。
- 新的 Windows helper 基础设施只负责安全 spawn、等待、重试、日志和清理；update 与 uninstall 使用独立动作脚本。
- core/self-uninstall.ts 负责当前可执行路径判定与平台化删除，不直接打印文案。

### CI boundary

- 通用 verify 使用 fake fetch、临时 CCQ_HOME 和依赖注入。
- Windows runner 执行真实 PowerShell helper。
- Windows 编译产物 smoke 执行真实自卸载；四平台 smoke 继续验证 version/help。

## 3. Confirmed Cross-Task Contracts

| Contract | CLI child | Lifecycle child |
|---|---|---|
| CLI update 不启动 TUI | help 文案与命令输出 | restart policy=false |
| TUI update 自动重启 | 无 | restart policy=true + renderer cleanup |
| tools update 实时刷新 | parser/command/cache 调用 | 无 |
| digest fail closed | help 可描述失败 | Release plan/download/apply |
| Windows uninstall scheduled | help/退出码 | helper/delete verification |

## 4. Integration Ordering

1. CLI 子任务先完成 parser、help 与 registry 测试，减少后续生命周期命令输出的漂移。
2. 生命周期子任务引入事务类型和 helper，不改变既有 CLI 动词形状。
3. 父任务统一检查 help、AGENTS、package verify、Windows workflow 与 Release smoke。
4. 任何子任务失败都可独立回滚；不存在数据格式迁移。

## 5. Compatibility

- cc/cx 正常无双横线调用保持字节级 argv 顺序；修复仅恢复当前被丢弃的 token。
- ls/use/tools/uninstall 的命令形状不变。
- 自更新只允许升级是安全收紧；不会修改当前已安装版本。
- digest fail closed 可能把过去的继续下载改成显式失败，这是已确认的安全策略。
- Windows uninstall 从同步失败改为异步 scheduled success；macOS/Linux 仍同步删除。

## 6. Rollback

- CLI parser/registry 可独立回滚，不影响 update 事务文件。
- 自更新事务失败时旧目标保持不变，无需数据回滚。
- Windows helper 失败只留下临时文件/脱敏日志，可安全重试或手工清理。
- 不修改用户配置与 PATH，因此回滚不涉及用户数据恢复。
