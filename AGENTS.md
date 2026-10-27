# 协作约定

## 双语 README

- `README.md` 为面向公众的英文入口，`README.zh-CN.md` 为简体中文版本；两份文档必须互相提供语言切换链接。
- 修改功能介绍、安装与启动步骤、环境要求、渠道或平台支持、截图、重要限制和文档导航时，在同一个 PR 中同步更新两个语言版本，保持事实和操作步骤一致。
- README 保持面向使用者，详细实现与完整操作规则放在 `docs/`；不得把尚未发布的安装路径写成已经可用。
- Features 保持 3–5 个使用场景，每项 1–2 句；不要在列表后逐次追加新功能的操作段落。具体命令、参数、快捷键、重试时序及完整支持范围写入对应的 `docs/` 指南，README 只调整现有场景摘要、必要限制或导航。
- README 不作为功能更新日志。精简时保留 npm 优先的安装路径、运行环境、自动同步的 Codex 兼容性区块及当前 `DB Schema` 声明，并执行对应校验脚本。

## 提交与发布说明语言

- 用于生成发布说明的 Conventional Commit 标题及合并到 main 的 PR 标题使用英文；PR 讨论和详细说明可以使用中文。
- `CHANGELOG.md` 和公开 Release notes 使用英文。翻译历史条目时保留原有功能含义、PR 编号、commit 与 issue 链接。
- Release PR 中的人工校对可能被 release-please 重新生成覆盖；合并前若 main 或 Release PR 再次更新，需要重新核对发布说明的语言和完整性。

## UI 更改验证

- 任何涉及 UI 的更改，都必须使用 browser use 或 Playwright 打开实际页面，并对对应变更区域截图。
- 必须将截图贴到对应 PR 的评论（PR comment）中，便于评审者直接查看改动效果。

## PR 与合并提交的 Issue 关闭语句

- `Closes #<issue>` / `Fixes #<issue>` 必须放在 PR 描述和最终合并提交信息（包括 squash commit）的最后一行，与前文空一行，不得放在开头或正文中间。
- 关闭语句必须独占一行，仅包含关键词和 Issue 编号，不附加标点或说明。GitHub 本身允许同一行关闭多个 Issue；但当前锁定的 [release-please 17.6.0](https://github.com/googleapis/release-please/blob/v17.6.0/src/commit.ts#L192-L230) 每条 footer 仅解析一个纯数字 Issue 引用，因此本项目要求多个 Issue 在末尾逐行列出，每行一个，之后不得再追加正文。
- 合并前确认最终提交信息保留这些末尾语句，确保 release-please 能按 Conventional Commits footer 解析 Issue 引用并写入 changelog。本约定适用于后续 PR，不追溯修改历史 PR 或 changelog。

## Slash Command 实现追踪

- [Issue #69：Slash Command 完整支持矩阵与后续实现追踪](https://github.com/yuzheng14/codex-web-ui/issues/69) 是本项目 Slash Command 支持情况的统一追踪入口。
- 每次适配新的 Codex 版本时，核对该版本的 Slash Command 新增、删除、重命名、别名、参数、行为及可用条件变更，并同步更新 #69 的命令清单、版本依据和支持状态。
- 新增、修改或移除 Slash Command 相关功能时，同步更新 #69 的对应条目、实现范围、剩余缺口和 PR 链接；实现仍在 PR 中时注明待合并，合并后再更新已落地状态。
- 状态统一使用：✅ 已经完全实现、🟡 部分实现、⬜ 未实现、🚫 不考虑实现。已有类似 UI 或上游协议定义不代表 Slash Command 已实现；明确不做命令入口时记录原因。
