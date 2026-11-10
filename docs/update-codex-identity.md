# 升级重启时的 Codex 身份

更新检查分开记录当前 app-server 与重启目标。`status.codex` 继续使用运行实例的诊断；`available.codex` 使用目标启动环境的独立 CLI 探测，与所选 Covro 包的兼容声明比较。两者可以不同，不需要先断开当前会话。

## 方案比较

| 方法                                                          | 可靠性与限制                                                                                                                                                                   |
| ------------------------------------------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------ |
| 当前 app-server 的启动缓存                                    | 能描述当前连接，不能证明磁盘更新后重启会启动什么。保留作当前版本展示。                                                                                                         |
| npm 全局包版本、遍历宿主机新版、交互 shell 中直接执行 `codex` | 可能属于别的 Node prefix、PATH 或版本管理器，且忽略显式 `codex.binary` 和服务环境，不能作为升级放行依据。                                                                      |
| 在正在运行的进程中直接执行配置的 `binary --version`           | 优于包元数据，但 Node/PATH 迁移和持久服务的环境可能不同，单独使用仍不充分。                                                                                                    |
| 以目标 Node 和重启启动方式运行短时 CLI 探测                   | 本次采用。使用同一配置、有效 CODEX_HOME、PATH、工作目录和服务管理器；解析实际命中的可执行文件，记录版本与来源，随后重复检查。只执行 `--version`，不启动用于探测的 app-server。 |
| 先停止旧实例，启动新 app-server 再判断                        | 能观察实际进程，但过早中断会话。仅在原有空闲准入、备份和维护流程内，作为最后的激活验证。                                                                                       |

目标 Node/npm 仍沿用 #281 的 `resolveRuntimeTarget`，不另行扫描“最新 Codex”。Codex 的可执行文件按 Node 子进程的 PATH 顺序解析，显式绝对/相对路径优先；`codex.home` 覆盖 CODEX_HOME。相对路径以实际重启工作目录为基准。普通后台实例使用 worker 继承的环境加目标 PATH/COVRO_HOME，和 `startBackground`、macOS 临时 GUI 环境桥一致。

持久 launchd 服务将渲染后 plist 的环境和工作目录交给同一 GUI domain 中的独立短时 Node job。它移除 KeepAlive，单独命名，只运行 CLI 探测，随后卸载自身。持久 systemd 用户服务使用同一用户管理器的 transient service，转交渲染后 Environment/WorkingDirectory；它不继承调用终端的环境。systemd-run 使用 `--expand-environment=no` 保留配置路径中的字面量，需要已有 systemd 254 或更新版本支持该选项。缺少权限或工具时检查失败，不安装工具。

只支持可复现的 Covro 服务属性。systemd drop-in、EnvironmentFile、ExecStartPre、自定义沙箱/凭据/用户等属性，launchd 未识别的启动属性，以及环境中的动态 systemd specifier 均拒绝探测，应使用原部署方式更新。此约束在升级停止服务前执行；不修改用户的 shell 或服务配置来让探测通过。

## 一致性与保护

`CodexTarget` 保存配置文件摘要、持久启动来源摘要，以及 Codex 的配置名称、PATH 命中路径、符号链接解析路径、文件 stat 身份（设备、inode、大小、纳秒修改/变更时间）、CLI 版本、目标 Node、工作目录和环境摘要。环境原值可能有凭据，只在内存中用于子进程执行；更新状态只保存摘要。服务管理器每个进程注入的 invocation/job 标识不参与环境摘要。

手动、CLI 和自动升级经过同一个检查入口。自动升级仍只接受已验证组合；未验证版本仍需本次目标版本的明确确认，未知或明确不支持的组合不能绕过。并发检查串行执行并发布完整快照，避免把一次检查的 Node 与另一次检查的 Codex 组合。

已选中的预装 Covro 使用其自身的配置解析器。需要下载的发行版先按现有配置语义探测，安装到私有 prefix 后必须用候选包自己的探测入口再次得到相同身份；候选缺少入口、不能解析配置或改变启动来源时，停止切换并保留旧实例，使用原部署方式处理。这样不会用当前 Covro 的旧默认值假定目标包行为。

worker 在 npm 安装前、候选核验后、每次等待空闲时、准入关闭后和停止前重新探测。即使版本相同，路径、文件、配置、工作目录或环境摘要变化也会拒绝继续。升级、降级、移除或 PATH 回落到其他安装都需要重新检查，不静默改用别的安装。最后一次检查位于事务的 `beforeStop`：失败时恢复准入，不触发停止或备份；回滚停止动作不重复调用这个检查。

适配器在启动时观察文件身份，以绝对命中路径启动进程，再核对 `initialize.userAgent` 中的服务端构建版本及文件身份。Codex 0.167.0 的[初始化响应实现](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/app-server/src/request_processors/initialize_processor.rs)调用[服务端 User-Agent 构造函数](https://github.com/openai/codex/blob/rust-v0.167.0/codex-rs/login/src/auth/default_client.rs#L138)，其中版本取自服务端构建，区别于客户端传入版本。worker 和 daemon 激活入口都核对实际启动身份；偏差无法开放业务写入，继续走原有安装、配置和 SQLite 恢复流程。备份保护、未知执行、审批和空闲规则不变。

探测不是对任意脚本或版本管理器 shim 的真实性证明。它运行实际配置的命令，不能冻结之后被外部替换的文件或管理器环境；标准 npm 启动器的下游二进制也可能变化。重复观察与重启后握手能发现版本/来源偏差，最后的核验失败会回滚。若自定义启动器按进程专属标识、时间或外部状态选择不同内容，无法预先保证；应改用稳定的显式 binary 或原部署方式。读取到的 CLI 版本不证明模型、登录或项目任务可执行。

## 与 #325 的边界

#325 负责等待空闲期间重新选择 Covro 发行候选，包括自动升级订阅与候选记录。#335 不刷新渠道标签，不改变候选选择时序，不改写自动任务归属。

共享接点是 `UpdateManager.check/start` 与 worker 的候选准备、`waitForIdle`、`beforeStop`。`probeRestartCodex`/`assertCodexTarget` 是重启身份检查；`checkRunningCodex` 只用于新实例。#325 若替换候选，必须对新候选的 manifest 使用同一个重启目标身份；Node/安装来源一起改变时需重新探测并持久化 `run.codex.target`，不能恢复成当前 app-server 版本。刷新候选不得把未验证组合自动确认。对应的独立 PR 是 [#339](https://github.com/yuzheng14/covro/pull/339)。两个分支均从 main 独立实现，当前无跨 PR 代码依赖。两者都修改 manager、worker 和更新面板，不能把普通串联分支称为 Stack。合并前后都需核对共享改动；先合并任一个后，后一个需变基并保留 `performCheck/freezeAutomatic/commitActivation` 的候选固定规则，以及本 PR 的目标 Codex 探测、`beforeStop` 和实际 app-server 校验；还需将重启身份保存到 #339 的候选快照并让面板沿用它，重新执行组合测试。

## 验证范围

隔离进程测试复制 Node 和已构建 Covro 到临时 prefix，使用临时 HOME、配置、Codex home、数据库和 Unix socket。npm 与 Codex 协议使用仓库 fixture，不访问用户安装或调用模型。覆盖 Issue 给出的两个 Covro/两个 Codex 版本、显式旧路径、Node 迁移及重启偏差恢复。探测测试覆盖多版本 PATH、升降级、移除、配置/文件/启动来源变化和失败；服务管理器参数及清理路径通过模拟验证，不等同于真实 Linux systemd 或持久 launchd 服务升级。本机原生 Codex 0.167.0 已通过临时配置下的 CLI 目标探测，未用它运行完整升级或真实模型任务。

另有真实隔离服务的页面验证：复制构建产物到临时包并将前端构建版本元数据对齐临时包版本，通过页面按钮触发 Issue 示例升级，截图实际服务返回的升级前后状态。npm 与 Codex 仍是上述 fixture。

浏览器矩阵测试运行构建后的真实页面，以受控更新接口展示四种语言、明暗主题、桌面和窄屏下的运行版本、目标兼容性、重启完成及未知来源。矩阵截图里的升级状态为 UI fixture；系统 light/dark 两种偏好均验证，当前更新面板没有独立暗色主题。完整 worker/SQLite 激活和回滚由独立进程测试验证，不将二者描述为原生 Codex 端到端升级。用户当前 Covro 未升级、未重启。
