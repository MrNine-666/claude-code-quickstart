# Issue tracker: GitHub

本仓库的 issue 与 PRD 均以 GitHub issue 保存。所有操作使用 `gh` CLI。

## Conventions

- **创建 issue**：`gh issue create --title "..." --body "..."`。多行正文使用 heredoc。
- **读取 issue**：`gh issue view <number> --comments`，使用 `jq` 过滤 comment，
  并同时获取 label。
- **列出 issue**：`gh issue list --state open --json number,title,body,labels,comments --jq '[.[] | {number, title, body, labels: [.labels[].name], comments: [.comments[].body]}]'`，
  并按需添加 `--label` 与 `--state` 过滤条件。
- **评论 issue**：`gh issue comment <number> --body "..."`
- **添加或移除 label**：`gh issue edit <number> --add-label "..."` /
  `--remove-label "..."`
- **关闭 issue**：`gh issue close <number> --comment "..."`

仓库身份从 `git remote -v` 推导；在 clone 中运行时，`gh` 会自动完成该操作。

## Pull Requests as a Triage Surface

**是否将 PR 作为需求入口：no。**（如果本仓库把外部 PR 当作功能请求，则设为
`yes`；`/triage` 会读取此标志。）

设为 `yes` 时，PR 使用与 issue 相同的 label 和状态，并改用对应的 `gh pr` 命令：

- **读取 PR**：使用 `gh pr view <number> --comments`，并用
  `gh pr diff <number>` 查看 diff。
- **列出待 triage 的外部 PR**：运行
  `gh pr list --state open --json number,title,body,labels,author,authorAssociation,comments`，
  然后只保留 `authorAssociation` 为 `CONTRIBUTOR`、
  `FIRST_TIME_CONTRIBUTOR` 或 `NONE` 的记录（排除
  `OWNER`/`MEMBER`/`COLLABORATOR`）。
- **评论、标记或关闭**：使用 `gh pr comment`、
  `gh pr edit --add-label`/`--remove-label`、`gh pr close`。

GitHub 的 issue 和 PR 共用编号空间，因此单独的 `#42` 可能属于任意一种。先运行
`gh pr view 42`，失败后再回退到 `gh issue view 42`。

## When a Skill Says "Publish to the Issue Tracker"

创建一个 GitHub issue。

## When a Skill Says "Fetch the Relevant Ticket"

运行 `gh issue view <number> --comments`。

## Wayfinding Operations

本节供 `/wayfinder` 使用。**map** 是单个 issue，**child** issue 是具体 ticket。

- **Map**：单个带 `wayfinder:map` label 的 issue，正文保存 Notes /
  Decisions-so-far / Fog。使用 `gh issue create --label wayfinder:map` 创建。
- **Child ticket**：作为 GitHub sub-issue 链接到 map 的 issue（通过 sub-issues
  endpoint 调用 `gh api`）。如果未启用 sub-issue，则把 child 加入 map 正文的
  task list，并在 child 正文开头写入 `Part of #<map>`。Label 使用
  `wayfinder:<type>`（`research`/`prototype`/`grilling`/`task`）。Ticket 被认领后，
  分配给负责推进的 developer。
- **Blocking**：使用 GitHub **原生 issue dependency** 作为标准且在 UI 可见的
  表达。通过
  `gh api --method POST repos/<owner>/<repo>/issues/<child>/dependencies/blocked_by -F issue_id=<blocker-db-id>`
  添加依赖边；其中 `<blocker-db-id>` 是 blocker 的数字 **database id**
  （通过 `gh api repos/<owner>/<repo>/issues/<n> --jq .id` 获取，不能使用
  `#number` 或 `node_id`）。GitHub 的 `issue_dependencies_summary.blocked_by`
  只报告仍打开的 blocker，并作为实时门禁。无法使用 dependency 时，回退为 child
  正文开头的 `Blocked by: #<n>, #<n>`。所有 blocker 关闭后，ticket 才算解除阻塞。
- **Frontier query**：列出 map 中仍打开的 child（使用 `gh issue list --state open`，
  并限定于 map 的 sub-issue 或 task list），排除存在开放 blocker
  （`issue_dependencies_summary.blocked_by > 0`，或 `Blocked by` 行中仍有开放
  issue）以及已有 assignee 的记录；按 map 顺序选择第一个。
- **Claim**：`gh issue edit <n> --add-assignee @me`，这是 session 的第一次写操作。
- **Resolve**：先运行 `gh issue comment <n> --body "<answer>"`，再运行
  `gh issue close <n>`，最后向 map 的 Decisions-so-far 追加 context 指针
  （gist 和链接）。
