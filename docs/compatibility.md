# Codex 协议兼容性

<!-- codex-compatibility:start -->

推荐 Codex CLI：**0.166.0**。已验证版本：`0.166.0`。

<!-- codex-compatibility:end -->

当前基线为 `codex-cli 0.166.0`，核验日期：2026-11-02（Asia/Shanghai）。稳定协议由显式指定的官方完整安装重新生成，单一 verified 版本为 0.166.0；0.164.0、未单独适配的 0.165.0 与其他版本继续走 unverified 确认。来源与实验字段差异见 [协议审查](codex-0.166.0-protocol.md)，本轮范围与限制见 [升级验证](codex-0.166.0-verification.md)。此前 [0.164.0 验证](codex-0.164.0-verification.md) 与 [0.163.0 验证](codex-0.163.0-verification.md) 保留为历史证据。

以下映射适用于 0.166.0；下文保留的旧版本实测日期与版本仍表示历史证据，不扩大为新版完整验证。

`src/codex/generated/` 是本机该版本执行 `codex app-server generate-ts --out ./src/codex/generated` 的原始产物，未手工修改。`src/codex/protocol-version.json` 记录来源。更新协议需显式执行 `pnpm codex:generate -- --config ./config.local.json`，使用配置中的 `codex.binary`；安装与启动不会更新 CLI 或重新生成协议。生成文件仅用于服务端适配和模拟器的静态类型约束，浏览器使用 `src/shared/types.ts`。

官方接口背景见 [Codex App Server 文档](https://learn.chatgpt.com/docs/app-server)。应用以本仓库生成的目标版本类型为准，重点差异如下。

会话创建方 `Thread.originator` 原样进入详情与列表摘要，缺失时返回 `null`。来源展示优先精确识别 `codex_web_ui`、`codex-tui`、`codex_vscode` 和 `Codex Desktop`，其他非空创建方原样显示。仅有 `source: vscode` 时不能判断具体客户端：0.162.1 的独立 app-server 启动路径固定使用 VSCode 来源，网页和连接共享后台服务的终端会话也可能属于此类，因此显示“交互客户端”。协议 `source: appServer` 映射内部 MCP 来源，显示 MCP；原始 `source` 保留以兼容已有接口、关联记录和未知来源兜底。依据为上游 [CLI 启动代码](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/cli/src/main.rs)、[来源映射](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server-protocol/src/protocol/v2/thread_data.rs)、[客户端身份示例](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server-protocol/src/protocol/common.rs)及[初始化处理](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/app-server/src/request_processors/initialize_processor.rs)。这些字段描述创建入口，与当前执行进程、任务状态和连接状态分别展示。

| 项目         | 0.166.0 的映射                                                                                                                                                                                                       |
| ------------ | -------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 握手         | `initialize` 成功后发送 `initialized`，随后读认证和模型；`experimentalApi: true` 允许结构化用户请求                                                                                                                  |
| 历史来源     | `thread/list.sourceKinds` 显式为 `cli`、`appServer`、`vscode`；`cwd` 使用项目的 `canonicalRoot` 精确过滤，每页最多 30 条，按更新时间倒序，不扫描全局历史；其他路径别名和子目录历史不自动收集，服务层继续校验项目归属 |
| 分页历史     | `Thread.historyMode` 可为 `paginated`；此时用 `thread/turns/list` 与必要的 `thread/items/list` 完整加载，不假定 `thread/read(includeTurns)` 覆盖所有历史                                                             |
| 新建、恢复   | `thread/start`、`thread/resume` 只映射已定义设置；恢复附带服务端已校验的 `cwd`                                                                                                                                       |
| 分叉会话     | `thread/fork` 使用源会话校验后的 `cwd`、`excludeTurns: true`，省略 `lastTurnId`；新 ID 再通过历史读取接口加载，保留 `forkedFromId`。运行中的源会话继续执行，分支记录已保存历史及中断状态                             |
| 文本输入     | `input: [{ type: 'text', text, text_elements: [] }]`，追加要求使用 `turn/steer.expectedTurnId`                                                                                                                       |
| 推理强度     | turn 使用 `effort`；新建和恢复通过协议支持的 `config.model_reasoning_effort` 设置；选项来自 `model/list`                                                                                                             |
| 权限         | thread 使用 `sandbox` 枚举；turn 映射为 `sandboxPolicy` 对象，不直接透传浏览器字段                                                                                                                                   |
| 审批         | command/file 使用各自 decision 枚举；命令规则和网络规则只能采用上游请求提供的具体 amendment                                                                                                                          |
| 额外权限     | `item/permissions/requestApproval` 展示原始请求的网络及文件范围；允许本轮/本会话分别回复 `scope: turn/session`，拒绝回复空权限；浏览器不能提交或扩大权限范围                                                         |
| MCP 交互     | `mcpServer/elicitation/request` 支持 `form`、`openai/form`、`openaiForm` 的平面表单及 `url` 模式；回复 `action/content/_meta`，拒绝与取消保持独立语义。URL 仅允许 HTTP/HTTPS，必须由用户主动打开                     |
| 结构化问题   | `item/tool/requestUserInput`，回复为 `{ answers: { questionId: { answers: [...] } } }`；校验选项、自由输入和题目 ID，保留 `isBlocking` 语义                                                                          |
| 回答确认     | 写入回复后保持 responding；`serverRequest/resolved` 才确认 answered，turn 结束或进程退出使遗留请求失效                                                                                                               |
| 自动审核展示 | `item/autoApprovalReview/started`、`item/autoApprovalReview/completed` 按独立 `reviewId` 合并，只读展示操作、状态、风险和原因；不发送审批回复，也不据此判定任务完成                                                  |
| 请求 ID      | 字符串与数字分别匹配，数字 `0` 有效；不依赖响应顺序                                                                                                                                                                  |
| 新活动类型   | 保留稳定 item ID，以通用活动详情展示；未知交互请求显示兼容错误并回复 JSON-RPC `-32601`，不会自动同意                                                                                                                 |

MCP 表单支持字符串、数字、整数、布尔值、单选和多选，以及必填、长度、数值范围、选项和数组长度约束。服务端在领取请求前校验回答，保留 `false`、`0` 和字符串空白；适配层发送前再次校验。不支持的结构或约束会显示说明并禁止接受，但仍允许明确拒绝或取消；不会默默忽略约束后授权。权限目标和表单控制信息不会随长会话输出一起被截断。

自动审核状态区分 `inProgress`、`approved`、`denied`、`timedOut` 和 `aborted`。本轮结束或运行进程退出时仍未收到结果的审核显示“结果未确认”，不推断为允许或拒绝；迟到的开始通知不会覆盖已收到的终态。记录保留在网关内存投影中，浏览器刷新和重连可恢复；当前协议的会话历史不含审核通知，因此不承诺网关重启后恢复。严格审核要求、Guardian 警告和 `thread/approveGuardianDeniedAction` 的人工再次授权入口尚未接入。

2026-10-14 的 Fork 检查使用真实 `0.162.1`、独立临时 `CODEX_HOME` 和人工构造的持久历史，无登录、无模型请求。已验证新 ID、父会话 ID、目录与消息复制、completed 状态保留，以及源历史文件逐字节不变；未结束的静态历史副本为 interrupted。真实运行中推理及真实分页 Fork 未在此检查中验证，相关行为由协议 fixture 覆盖。刚新建但未落盘的空会话会被 CLI 拒绝（`no rollout found`）。

历史列表保留上游分页游标。归属筛选后某页可能较少或为空，仍可通过“加载更多”继续下一页；不能将空页误判为历史结束。

默认 RPC 回执期限 30 秒，与 turn 执行时间分开。回执超时、写入失败、进程退出及协议错误均保留可能已执行的不确定性；不会自动重发 prompt。stdout 单行上限 8 MiB，stdin 待写上限 4 MiB，待确认 RPC 上限 256；stderr 只保存 64 KiB 内存尾部，不返回给浏览器。子进程只使用参数数组启动，继承用户环境；仅配置 `codex.home` 时覆盖子进程的 `CODEX_HOME`。关闭时只处理本服务持有的子进程，有限等待后强制结束。

运行版本位于当前包 `covroCodex.verified` 列表时显示 verified；其他版本显示 unverified，不伪装验证成功。`initialize` 的客户端版本与能力开关不提供跨 CLI 版本的 schema 兼容保证；重新生成类型也不等于验证了运行行为。上游明确拒绝某方法为不支持后，该方法被禁用并显示原因。缺少认证、模型查询或初始化能力时保留明确诊断，不进入无限重启。

## 未验证版本的使用确认

已验证版本直接使用。未验证版本通过握手与基础查询后，页面显示运行版本、已验证版本和“部分功能可能无法正常使用”的提示，提供“暂不使用”和“确认继续”。取消后仍可查看历史与诊断，并从提示条重新打开确认；确认不会自动重放先前任务，也不会清空草稿。

`GET /api/system` 的 `compatibilityConfirmation` 为 `not-required`、`required` 或 `confirmed`。客户端通过 `POST /api/system/compatibility/confirm` 明确确认，提交新的 `clientOperationId`、当前 `codexEpoch`、`codexVersion`、`verifiedVersion` 和 `confirm: true`，返回可查询、可去重的标准操作回执。此接口使用与其他变更操作相同的身份、Origin、JSON 和请求体校验。

确认前，服务端阻止新建、Fork、恢复、发送、追加和回答人工请求，返回 `COMPATIBILITY_CONFIRMATION_REQUIRED`；新确认携带旧版本或旧运行实例时返回 `COMPATIBILITY_CHANGED`。重试相同操作 ID 只返回原回执，不重新授权。读取历史、查看诊断、正常中断和原有人工核对不受该确认门槛影响。确认只允许尝试尚未验证的版本，不能绕过初始化失败或已经禁用的方法。

确认在网关内存中绑定运行版本、已验证版本和 Codex 运行实例。同一实例内刷新、重连或打开其他标签页共享确认；网关或 Codex 重启、版本变化后重新确认。持久化操作回执仅用于审计和查询，不会在重启后重新授予确认。已确认的版本仍显示“尚未验证”，不会变为 verified。

确认请求结果不明时，可刷新确认状态；如果仍需确认，可显式“重新确认”。页面先重新读取当前运行状态，仅在版本与实例仍与提示一致时创建新的确认操作，保留旧审计记录。这不会自动重发任务，也不会以旧回执恢复授权。

## 实际验证

- 无账号模拟测试使用真实子进程，覆盖 UTF-8 跨字节、分片、多行、交错通知/请求/响应、字符串与数字 ID、回执延迟与超时、真实终态、命令/文件/网络审批、结构化问题、未知交互、异常退出、分页历史及不支持的方法。
- 本机真实 `0.162.1` 已通过版本检查、`initialize → initialized`、`account/read` 和 `model/list`；认证可用，返回 7 个模型。未打印账户内容或令牌。
- 当前开发沙箱直接启动 app-server 会返回 `Operation not permitted`；经执行环境允许的沙箱外运行完成上述真实诊断。这是开发环境限制，不会自动切换为模拟数据。
- `pnpm test:live` 默认只执行上述诊断，不发起模型推理。`pnpm test:live -- --inference` 显式使用额度，在独立临时目录创建 `smoke.txt`、核对内容、继续对话、检查历史，并验证无事件订阅期间 app-server PID 不变。可用 `--output /tmp/report.json` 保存范围明确的报告。
- 本机真实推理冒烟已完成：临时项目文件内容正确、收到实际文件变更、继续对话和历史查询通过；无需执行 shell，因此该轮没有命令输出，不能将此写成真实命令输出验证。网页断线恢复、实际人工审批及经 Cloudflare 的完整访问，须以 `docs/verification.md` 中对应实测记录为准；适配器的订阅测试不等同于浏览器或 Tunnel 验证。

本应用不更改全局 Codex 配置、不自动登录或升级、不编辑 Codex 的内部数据库或 rollout 文件。恢复会话时由 Codex 的跨进程写入锁判定占用。已用本机 0.162.1 的两个独立进程验证 legacy、paginated 历史：持有写入权时，另一进程的 `thread/read` 可返回 `notLoaded`，而 `thread/resume` 返回 `-32600` 和 `thread <当前 ID> already has an active writer`；原进程退出后恢复成功。适配层严格匹配错误码、当前 ID 和完整错误文本，再映射为 `THREAD_IN_USE`；其他错误不推断为占用。未来版本若改变错误格式，会显示原始恢复错误，不冒充占用。旧客户端的 `confirmExternalStopped` 参数继续接受，但不再作为恢复前提。

## 异步提问兼容范围

`request_user_input_async` 通过助手消息携带问题，不需要切换 Plan 模式，也不依赖 `default_mode_request_user_input`。参考 Codex 0.162.1 的 [工具实现](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/core/src/tools/handlers/request_user_input_async.rs) 与 [原生答案信封](https://github.com/openai/codex/blob/rust-v0.162.1/codex-rs/tui/src/async_question_reply.rs)。它不创建阻塞 RPC，请勿把异步问题转换成人工审批或伪造等待输入状态。

WebUI 将结构化问题显示在所属助手消息中，每组支持一次回答多个问题。任意选项题均可改用自由回答，纯文本题必须填写；不会因默认选中首项、刷新或重连自动发送。运行中使用现有 `turn/steer` 链路，结束后使用 `turn/start`，共享原有权限、兼容性、操作回执和结果不明保护。发送失败保留输入，状态变化引起的明确失败允许重试，但不自动重发答案。

原生答案以 `questionItemId = JSON.stringify(["request_user_input_async", messageId, questionIndex])` 逐题关联，兼容旧版按整条消息 ID 关联的回复，网页只显示可读的题目与答案；通过历史、Fork 或其他兼容客户端发送的原生答案也能恢复已发送状态。普通聊天消息不会被猜测为已回答。大快照缩减保留问题选项与回复关联，超限时明确报告，避免丢掉表单或重新开放已回答的问题。未发送的回答仅保留在当前已挂载的会话界面中，刷新或切换会话后需要重新填写。

## 发行版兼容声明

`package.json.covroCodex` 是当前发行版的兼容信息来源：`recommended` 对应生成协议的基线，`verified` 只包含实际验证过的确切版本，`unsupported` 记录明确不支持的确切版本及原因。不会从版本大小或范围推断未验证版本兼容。更新声明后执行 `pnpm compat:sync` 同步英中 README 和本文顶部；CI 验证文档与生成协议来源一致。适配新的 Codex 版本时仍须完成协议审查、行为验证及 Issue #69 的 Slash Command 支持核对。

npm 包保留这份声明，GitHub Release 从其确切标签读取相同信息。升级检查会返回当前运行 Codex 与候选 Covro 的组合状态；自动安装只接受 verified。unverified 可以由用户对当前 Codex 和确切目标版本明确确认后尝试，确认不持久化为允许其他版本升级，也不把运行时状态改成 verified。声明缺失/无效、Codex 版本未知或明确 unsupported 时禁止受管升级。原有运行时未验证版本确认继续独立生效。

独立工作进程核对实际候选包与检查时的声明一致，在等待任务结束及关闭入口后复核运行版本；新版连接和版本验证通过才提交激活。等待期间 Codex 变化会终止升级并要求重新检查，重启后发现版本变化或连接不就绪则回滚。历史版本缺少声明时也不能直接受管降级，需要含有效声明的新发行版或沿用手工部署方式。
