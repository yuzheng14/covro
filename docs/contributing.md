# 开发与 PR 约定

## 本地开发与验证

环境要求和完整启动步骤见[从源码运行](../README.zh-CN.md#从源码运行)。配置完成后，在仓库根目录运行 `pnpm dev`，打开 <http://127.0.0.1:5173>；提交前执行以下检查：

```sh
pnpm format:check
node --import tsx scripts/verify-database-contract.ts
node --import tsx scripts/sync-compatibility.ts --check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

浏览器测试需要现有 Playwright 依赖所对应的 Chromium。测试与 CI 使用明确的测试夹具，不发起真实模型请求。提交问题时请附上操作系统、Node.js 与 Codex 版本、安装方式和复现步骤。

README 的 Features 只概括使用场景。新增按钮、命令、参数、快捷键和恢复细节应更新对应指南，避免逐次向 README 追加操作说明；面向使用者的事实、安装步骤和导航需同步维护中英文版本。

## 格式检查

项目复用已锁定的 Prettier 与 `.prettierrc.json`，使用以下命令检查或修复代码、文档和配置的格式：

```sh
pnpm format:check
pnpm format
```

`format:check` 只检查，格式不符合时列出文件并返回非零状态；`format` 会改写文件，执行后应检查 diff。CI 的 `quality` 任务在安装锁定依赖后先运行 `pnpm format:check`，格式失败会使必需状态 `verify` 失败并阻止合并。它沿用普通 PR、Stacked PR、Release PR 和 main 的现有检查入口。

`.prettierignore` 排除依赖、构建与浏览器测试产物、Codex 生成协议、Drizzle 迁移、锁文件和已有排除的规划文档。根目录的 `CHANGELOG.md` 与 `.release-please-manifest.json` 由 release-please 生成，也明确排除，避免生成器重新写入后让 Release PR 因格式失败。其他手写源码、文档与配置都参与检查。

## PR 标题

PR 标题采用 [Conventional Commits 1.0.0](https://www.conventionalcommits.org/en/v1.0.0/) 的提交头格式：

```text
<type>[optional scope][!]: <description>
```

允许的小写 type 与 [ani-dock 的规则](https://github.com/yuzheng14/ani-dock/blob/main/.github/workflows/pr-title.yml) 一致：`feat`、`fix`、`deps`、`perf`、`build`、`revert`、`docs`、`refactor`、`test`、`ci`、`chore`。scope 可省略；填写时用非空括号，例如 `(ui)`。破坏性变更使用紧邻冒号的 `!`。冒号后必须有空格及非空描述。用于合并到 main 和生成发布说明的标题使用英文，与 `AGENTS.md` 一致；PR 讨论和详细说明可以使用中文。标题必须为单行。

```text
feat(ui): add JSON preview
fix: preserve scroll position
deps: update locked dependencies
feat(api)!: change the response format
chore(main): release 0.2.0
```

`Add JSON preview` 缺少 type，`fix: ` 缺少描述，`feature: add preview` 使用了未支持的 type，都会失败。失败日志提供原因、允许的 type 和正确示例。在 GitHub 编辑标题即可触发新检查，无需新增或修改提交。本期只检查 PR 标题，不逐条检查分支提交，也不检查标题拼写。

## 检查、fork 与 Stack

独立工作流 `.github/workflows/pr-title.yml` 提供 `PR title` 状态，在 PR 创建、重新打开、标题编辑、更新提交和标记 ready 时运行。它直接读取 GitHub API 中的最新标题，避免用旧事件里的标题覆盖新结果。同一个 PR 的旧运行会被取消。

工作流使用只读 `pull_request` 事件，兼容 fork；没有 base 分支过滤，因此每层 Stacked PR 都会检查。它不使用 `pull_request_target`、写权限或仓库 secrets，不安装项目依赖，标题也不会插入 shell 命令。`scripts/check-pr-title.ts` 仅使用 Node 标准库和 GitHub runner 已有的 `gh`。fork 的 Actions 运行若需要维护者批准，应先批准只读检查；检查未通过前不能合并。

Release PR 使用相同规则，不豁免机器人。默认标题 `chore(main): release X.Y.Z` 合法。`GITHUB_TOKEN` 创建或更新 PR 不会自动触发普通 PR 工作流，所以 `release-please.yml` 显式派发原有 `checks.yml` 和标题工作流，后者携带 PR 编号：

```sh
gh workflow run pr-title.yml --repo yuzheng14/covro --ref <pr-head-branch> -f pr_number=<number>
```

手工重跑也必须选择该 PR 的 head 分支，使状态关联正确提交。脚本核对 API 中的 head SHA 与工作流提交，错用其他 PR 编号或旧分支会失败；只在 main 上检查另一个 PR 的标题不能代替该 PR 的必需检查。

维护者应在 main 的 GitHub Rulesets 或分支保护中同时要求 GitHub Actions 的 `verify` 与 `PR title` 状态，不配置绕过。`verify` 继续汇总代码质量与全部 E2E 分片；`PR title` 独立更新，修改标题不会重跑整套 E2E，也不能把之前失败的 `verify` 覆盖为成功。仅新增工作流不会自动修改 GitHub 的合并规则。Stack 每层均须检查标题并完成评审；若合并到 main 之外的受保护分支，也应配置相同的必需状态。

可审查的 main 门禁配置保存在 `.github/rulesets/pr-checks.json`，两个状态均绑定 GitHub Actions（integration ID `15368`），没有绕过角色。创建前先核对现有规则，已有规则应更新而非重复创建。维护者可通过以下命令应用：

```sh
gh api --method POST repos/yuzheng14/covro/rulesets --input .github/rulesets/pr-checks.json
```

## 最终提交与发版

仓库只允许 squash 合并，设置 `squash_merge_commit_title=PR_TITLE`、`squash_merge_commit_message=PR_BODY`。无论分支有一个还是多个提交，默认 squash 提交标题都来自 PR 标题。合并界面允许人工修改最终信息，维护者应保留已通过检查的提交头；标题检查无法验证之后手工改写的内容。

分支内的临时提交不要求全部符合规范。如果未来启用 merge commit 或 rebase 合并，必须另外校验保留下来的每条提交，PR 标题检查不能代替它们。Stack 中每层仍使用该层已通过检查的标题。

现有 `release-please-config.json` 的 `node` 发布策略可解析以上 type：`feat` 驱动功能版本，`fix`、`deps`、`perf` 驱动修复版本；其他 type 通常不单独触发版本或显示在默认 Changelog 中。任意 type 都可以通过 `!` 表达破坏性变更。当前 `bump-minor-pre-major: true` 使 1.0.0 之前的破坏性变更递增次版本。继续保留默认 Changelog 分组与筛选，正式 GitHub Release 发布时在原条目上补充 `by @username`，让 GitHub 显示原生 Contributors 头像区；Release PR 和 CHANGELOG 不额外改写署名。详见[发版操作](releases.md)。格式合法不代表应当发版，应按实际变化选择 type。
