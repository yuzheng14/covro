# 协作约定

## 结构化日志

- 服务端统一使用 `src/logging/` 的 `Logger` 接口（Pino + pino-roll），将经过字段白名单过滤的元数据写入实例 `logs/` 下的私有 JSONL 文件，支持轮转、保留策略和故障降级。操作与排障说明见 [docs/logging.md](docs/logging.md)。
- 新增或修改 HTTP/WebSocket/MCP 边界、Codex RPC、后台任务、持久化状态转换，以及重试、恢复、取消或失败分支时，必须检查现有日志是否足以解释结果；缺少诊断证据时，在对应边界或状态变化处补日志。纯计算、渲染、快照读取、轮询成功和逐 token/逐分片事件不应重复记录。
- 复用入口传入的 `Logger`，通过 `logger.child({ component: 'question_tracking' })` 绑定固定英文组件名；可复用模块允许默认 `nullLogger`，生产调用方必须传递已有 logger。只有进程入口负责创建、flush 和关闭日志，不在业务模块另建文件 writer，也不使用 `console.*` 或直接输出原始 stderr 代替运行日志。面向使用者的 CLI 输出与日志保持分离。
- 调用形式为 `logger.info('module.event', { threadId, operationId, state })`，事件名使用固定的小写点分命名，不拼接用户内容。重要生命周期、持久化状态变化用 `info`，正常的高频诊断用 `debug`，可恢复失败、降级或结果待核对用 `warn`，导致功能不可用的失败用 `error`；`fatal` 留给进程无法继续的情况。沿用已有边界日志，避免每层重复记录同一错误。
- HTTP 已生成 `requestId`，业务操作使用 `operationId`；通过 `withLogContext` 传递异步上下文。跨通知、定时器或队列的任务，在接受任务时用 `logger.child({ ...logContext(), jobId, threadId })` 捕获关联字段，知道 `turnId`、`codexEpoch` 或 `sourceThreadId` 时一并关联。异步任务记录开始和最终 outcome、durationMs；数据库状态日志必须在事务提交成功后输出，重复通知或无变化读取不得伪造状态转换。
- 只记录必要的 ID、计数、耗时、状态和固定原因码。异常通过 `errorFields(error)` 转换。禁止记录 prompt、消息/标题/问题/答案正文（包括非秘密答案）、模型输出、工具参数/输出、请求/响应体、认证信息、环境变量、任意路径/URL，或原始异常的 message、stack、cause、details；此规则对 `debug` 同样适用。
- 字段边界位于 `src/logging/fields.ts`；新增字段必须审查其来源并补隐私测试。白名单只限制字段名和标量格式，不会把任意字符串自动变安全；`reason`、`state` 等标签应取受控值，禁止把敏感文本塞入允许的字段。
- 使用 `tests/fixtures/logging.ts` 的 `captureLogger()` 验证关键成功/失败/不确定分支、关联 ID 和最终 outcome，并断言敏感内容未进入日志。诊断时使用 `covro logs --thread THREAD_ID --since 1h` 或 `--event EVENT --json`；`covro status` / `covro doctor` 可查看写入降级和丢弃计数。

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
