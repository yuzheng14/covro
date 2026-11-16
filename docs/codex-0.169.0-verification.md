# Codex 0.169.0 升级验证

日期：2026-11-16（Asia/Shanghai），对应 [#351](https://github.com/yuzheng14/covro/issues/351)。协议来源与范围见 [协议审查](codex-0.169.0-protocol.md)，机器可读报告见 [结果记录](codex-0.169.0-results.json)。

## 候选实现

四层分别处理 provider 模型目录与默认值边界、临时标题/recap 子代理隔离、答案 moderation/账号身份/非重试错误，以及最终协议与精确版本门禁。前三层保留原 0.167.0 声明，栈顶将生成协议、recommended、单一 verified、live-settings 精确版本和双语 README 同时切换为 0.169.0。**当前仍为待审查候选，不表示已经发布或合并**；DB Schema 保持 10，锁文件和依赖声明未变。

provider 目录失败不会阻断只读历史，也不借用默认 provider 的模型；运行重启后保留 provider 归属并将目录置为不可用，等待重新读取。可选配置接口缺失不应阻断无模型设置的普通创建操作。跨 provider 选择返回 threadOnly，不写入新会话默认值。

## 真实 CLI 与本地模型 stub

全部明确指定已有完整 0.169.0 安装，使用全新 CODEX_HOME、临时项目和本地 HTTP Responses stub；不加载真实认证，不手写内部数据库或 rollout。

- `verify-codex-upgrade.ts --expected-version 0.169.0`：legacy/paginated 原生历史压缩、冷恢复、已确认设置、显式覆盖、双进程 writer conflict、Fork 血缘、无工具自动标题、命名 profile 收紧、压缩失败后续聊和嵌套 cwd 配置。
- `verify-live-settings.ts --expected-version 0.169.0`：首个模型请求在途时发布 Fast，后续请求实际携带 priority；审核方更新保留现有人工审批并明确拒绝；模型/effort 下轮生效，标准速度清除 Fast。
- `verify-codex-166.ts --expected-version 0.169.0`：两个历史模式中 modelNotFound、policyCapacityUnavailable、inferenceHookDenied、sessionBudgetExceeded 终态及历史；缺失保存的 provider 拒绝恢复；无 ChatGPT 认证时 GCP account/read。
- `verify-provider-history.ts --config <目标配置> --output-dir <截图目录>`：切换默认 provider 后活动/归档发现、精确 cwd、旧目录与实际旧 endpoint、新会话实际新 endpoint、外部选择不写默认值。生产前端 1280px/390px 页面及模型设置通过，无横向溢出。
- `verify-codex-169.ts --config <目标配置>`：不覆盖 Code Mode 默认开关，约 500 KB 文本输出交付有界 40,343 字节；legacy/paginated 中断待文件审批 A、启动 B、迟到取消 A，B 完成且文件未写入。
- `verify-managed-mcp.ts --binary <目标 binary>`：写入审批拒绝、原生 Code Mode 工具发现、同进程子会话及续聊、重启后重新注入、关闭清理与独立客户端隔离；标题和 recap 均无工具执行，用户配置逐字节不变。

不同 provider 的模型/effort/Fast 目录由协议 fixture 验证；真实自定义 provider 探针使用 bundled 目录，验证恢复与实际 endpoint 路由，不声称验证了原生不同目录来源。

复用项目现有锁定依赖、SDK 与已安装浏览器；离线安装下载数为零。生成类型在两个空目录中逐字节一致。Windows、Linux 与组织受管场景由 CI/后续环境验证，不将 macOS 结果扩展到这些平台。

## 本地检查

同步最新 main 后，完整单元/集成测试 **1681 通过、1 项原有跳过**；相关 Chromium 回归 **147 通过**（106 项会话/设置/审批等回归、32 项升级候选/重启四语与视口检查、9 项原生重连回归）。此前并行运行时的三项短超时单独重跑 28 项通过，最终完整运行限制测试 worker 数后全部通过，未修改测试超时阈值。CI 暴露的 provider 测试误计后台标题请求已按目标线程过滤；原生断流容量提示继续展示，但不增加网关重试。修复后相关 135 项和完整测试通过。typecheck、lint、格式、build、数据库声明、双语兼容块、生产产物、npm dry-run 打包及升级/回退 worker 检查通过；npm 传输仅为本地 fixture，没有真实安装或发布包。

## 待完成项与证据边界

**真实账号推理尚未执行。** 自动审批拒绝了复用现有认证发送外部模型请求的操作，原因是当前适配授权未明确包含该账号/凭证与外部推理流程。未发出模型请求，未使用额度；未使用的认证临时副本已删除，原始认证未改动。真实文件编辑、steer/cancel/人工拒绝及真实模型页面冒烟需人类明确授权后继续，CLI 加本地 stub 不替代这项验证。

截图来自实际运行的生产界面与真实 CLI 加本地模型 stub。Browser Use 原生浏览器连接返回 `cgWindowNotFound`，尚未上传为 PR 评论中的可显示图片。**本地截图路径不算满足项目截图要求**；保留 Draft，上传并确认显示前不宣称该要求完成。

完整 V1/V2 模型目录与配置优先级的子代理隔离矩阵、组织受管 prompt-user/网络代理、真实 OAuth/GCP/远程 backend、Code Mode 多媒体与完整续读矩阵、全部迟到 abort/相同更新时间分页组合、手机真机未全面实测。metadata 的旧字段兼容、false/null、迟到额度回包及终止错误归类由 fixture 覆盖；不将它们写成真实服务端产生了该元数据。

## 回退

显式选择完整 0.169.0 安装后重启网关；本轮未替换用户默认 CLI 或全局配置。候选只声明 0.169.0，回退到 0.167.0、0.168.0 或其他版本会进入 unverified 确认；不沿用旧 epoch 授权、不自动重放任务。最终合并前需核对整栈检查、截图评论和上述待完成项。
