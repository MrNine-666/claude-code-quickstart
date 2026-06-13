# Coding Style Guide

> 此文件定义团队编码规范，所有 LLM 工具在修改代码时必须遵守。
> 提交到 Git，团队共享。

## General
- Prefer small, reviewable changes; avoid unrelated refactors.
- Keep functions short (<50 lines); avoid deep nesting (≤3 levels).
- Name things explicitly; no single-letter variables except loop counters.
- Handle errors explicitly; never swallow errors silently.

## Language-Specific

### PowerShell
- 使用 `Set-StrictMode -Version Latest` 确保严格模式
- 接收函数/cmdlet 返回值时使用 `@()` 包裹强制数组上下文
- 返回数组的函数使用 `return ,$array` 防止展开
- 路径操作使用双引号包裹，优先使用正斜杠 `/`

### Shell (Bash/Zsh)
- 始终引用变量：`"${var}"` 而非 `$var`
- 使用 `[[ ]]` 而非 `[ ]` 进行条件判断
- 错误处理使用 `set -e` 或显式检查返回值

### JavaScript/Node.js
- 使用 `const` / `let`，避免 `var`
- 优先使用 async/await 而非 Promise 链
- 错误处理：不吞噬 catch，记录或重新抛出

## Git Commits
- Conventional Commits, imperative mood.
- Atomic commits: one logical change per commit.
- 中文提交信息，清晰描述改动动机和影响范围

## Testing
- Every feat/fix MUST include corresponding tests.
- Coverage must not decrease.
- Fix flow: write failing test FIRST, then fix code.

## Security
- Never log secrets (tokens/keys/cookies/JWT).
- Validate inputs at trust boundaries.
- 使用环境变量管理敏感配置，不硬编码
