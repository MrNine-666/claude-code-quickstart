# Migration Baseline

本任务开始时，根 Trellis 管理块按包含起止标记的精确 UTF-8 文本计算，
SHA-256 为
`C1F511B1CFC1902F2147DA159F09CC51F380B0C9E341CDB3AC5DEA5233F3E307`，
文本长度为 1060 个字符。

迁移前已有改动的 spec 是原 installer layer 中的 `platform-runtime.md` 和
`windows-core.md`。

这些已有改动描述 Windows 运行中映像替换合同。一对一移动到
`.trellis/spec/project/installer/` 后，这些改动仍然可见。

与本任务无关且已有改动的实现文件包括：

- `installer/contracts/Test-Contracts.ps1`
- `installer/windows/core/Process.ps1`

这些文件不属于本次文档迁移，不得因本任务而修改。
