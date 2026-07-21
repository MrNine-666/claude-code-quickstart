# 修复 nvm 中文用户目录安装失败

## Goal

避免 Windows 用户目录包含中文或其他非 ASCII 字符时，官方
`nvm-windows` 安装完成但无法识别自身 root，最终导致 Node.js 安装步骤失败。

本任务仅记录为待修复项，尚未进入实施阶段。

## Background

- Windows 安装链通过 winget 包 `CoreyButler.NVMforWindows` 安装官方
  nvm-windows 1.2.2，并使用 `--silent` 采用默认安装配置。
- winget 清单将默认安装目录设为 `%LocalAppData%\nvm`，因此路径会包含
  Windows 用户目录名。
- 用户截图中的直接错误为
  `C:\Users\<乱码用户名>\AppData\Local\nvm could not be found or does not exist`；
  随后 `nvm install lts` 虽打印 `Installation complete`，但 `nvm list`
  未返回已安装版本。
- 官方 issue [coreybutler/nvm-windows#726](https://github.com/coreybutler/nvm-windows/issues/726)
  记录了相同症状：用户名或用户目录包含非 ASCII 字符时，`settings.txt`
  的 root 路径可能因 ANSI/UTF-8 编码不一致而损坏，特殊字符显示为 `�`。
- 仅去掉静默安装不能保证修复；只有用户在安装向导中主动改用纯 ASCII
  目录才会绕过该问题。

## Requirements

- R1: 保持使用官方 `CoreyButler.NVMforWindows` 安装器，不引入来源不明的
  nvm 分发包。
- R2: 新安装不得因 Windows 用户目录中的中文、重音字符或其他非 ASCII
  字符导致 nvm root 损坏。
- R3: 优先评估让 Inno Setup 安装器使用固定的纯 ASCII root（候选：
  `C:\nvm4w`，通过 winget `--override "/DIR=C:\nvm4w"`）；实施前验证
  安装器参数、管理员权限、目录 ACL、多用户环境和升级行为。
- R4: 兼容已经存在的 nvm-windows；不得仅覆盖 `NVM_HOME` 而使已有版本
  目录失联，也不得未经确认迁移或删除用户现有 Node.js/provider。
- R5: 安装后以实际行为校验成功：`nvm root` 指向有效目录、`nvm list`
  能看到刚安装的版本，并且 `node --version` 与 `npm --version` 均可用。
- R6: 失败诊断必须保留 nvm 命令输出与实际 root/settings 路径，避免把
  `Installation complete` 误判为完整安装成功。
- R7: 修复需要覆盖源码安装入口和构建后的 Windows 单文件安装器契约。

## Acceptance Criteria

- [ ] 为非 ASCII Windows 用户目录建立可自动执行的回归测试或等价夹具，
  能捕获“nvm 安装返回成功但 `nvm list` 为空”的原始症状。
- [ ] 全新安装使用可被 nvm 正确读取的 root，root 不因用户目录编码而损坏。
- [ ] `nvm install lts` 后，`nvm list` 返回目标版本且 `nvm use` 成功。
- [ ] `node --version` 和 `npm --version` 在同一安装会话中验证通过。
- [ ] 已有健康 nvm/Node.js 安装仍按当前 runtime-first 契约复用，不发生
  隐式迁移、卸载或 PATH 清理。
- [ ] 安装失败时不会报告假成功，并给出可定位 root/settings 编码问题的
  技术信息。
- [ ] `installer/contracts/Test-Contracts.ps1`、Windows `-ListSteps` 和相关
  构建产物验证通过。

## Likely Affected Files

- `installer/windows/steps/NodeJS-Nvm.ps1`
- `installer/windows/core/Process.ps1`
- `installer/contracts/Test-Contracts.ps1`
- `.trellis/spec/installer/steps.md`

## Out Of Scope

- Forking or patching the upstream nvm-windows executable.
- Silently moving an existing user's nvm root or installed Node.js versions.
- Implementing the fix as part of this recording-only request.
