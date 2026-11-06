# File reference verification / 文件引用验证

Date: 2026-11-06. Base: `origin/main` at `3d0b586`. Project recommended/verified Codex: **0.166.0**. The initial November 5 audit found default CLI **0.164.0**; the final November 6 environment reports **0.166.0**. This task does not install or upgrade a CLI or change the user's running Covro instance.

日期：2026-11-06。基于 `origin/main` 的 `3d0b586`；项目推荐/已验证版本为 **0.166.0**，11 月 5 日初查默认 CLI 为 **0.164.0**，11 月 6 日最终环境检查为 **0.166.0**；本任务未执行 CLI 安装/升级，也未改动正在运行的 Covro 实例。

## Checks / 检查

- TypeScript, ESLint, Prettier, production build, compatibility/README synchronization and `git diff --check` pass. No external dependency, browser or tool was installed; package and lock files are unchanged. Build retains the existing large-chunk advisory.
- Full unit/integration suite: **1531 passed, 1 existing skipped**. The first sandboxed run hit loopback/socket `EPERM`; the complete rerun with local socket access passed. File tests cover project/session cwd, unassigned draft allocation, unavailable/removed nested registrations, forged draft IDs, traversal, symlinks, range/cwd mismatches, disappearance, unreadable files, limits, offline/obsolete runtimes and native cancellation request shape.
- **90 browser tests passed** across composer layout/keyboard, files, skills, images, slash commands, first messages, mobile input and unassigned workspaces. After rebasing onto main’s persisted-message/clientId flow, **41 file/skill/first-message/pending-message tests passed**, including all 10 file acceptance tests.
- Real rendered pages use the production frontend and repository-owned subprocess fixture, on isolated ports. File acceptance checks include registered and unassigned first sends, native-form path text in received history, multiple Chinese/space/same-name paths, independent skill identity, browser images, file-only steering, atomic deletion/undo, query/workspace races, controlled-update draft recovery, errors/offline draft retention, literal `@`, IME and mobile button/touch input.
- Desktop and 390px screenshots cover English, 简体中文, 日本語 and 한국어, plus bound references with an image and a deleted-file error retaining the draft. Screenshot banners explicitly identify fixture simulation. [Ten screenshots were uploaded through Browser Use and verified to display on GitHub](https://github.com/yuzheng14/covro/pull/319#issuecomment-6675676517).

类型、lint、格式、构建、兼容性/双语 README 校验及 diff 检查通过，未新增依赖或下载工具。全量 **1531 项通过、1 项原有跳过**；最初沙箱阻止本地端口/套接字，开放测试所需回环访问后的全量重跑通过。**90 项浏览器回归通过**；同步 main 的消息持久化/clientId 链路后，另有 **41 项文件、技能、首条发送与待确认消息回归通过**，包括全部 10 项文件验收。截图来自生产前端的真实页面，后端明确使用仓库 fixture，不冒充真实模型推理；[十张截图已通过 Browser Use 上传到 PR 评论并核实显示](https://github.com/yuzheng14/covro/pull/319#issuecomment-6675676517)。

CI on implementation/test commit `8370f6c`: [quality, all eight E2E shards and verify passed](https://github.com/yuzheng14/covro/actions/runs/42155049210). The initial shard 3 attempt failed the existing mobile unread viewport assertion (including its automatic retry). No code/assertion was changed: clean main and this PR each passed that case twice locally; the requested job rerun passed all 75 shard cases and the full workflow finished successfully. The initial failure remains in the run history.

实现/原生验收提交 `8370f6c` 的 [quality、8 个 E2E 分片及 verify 均通过](https://github.com/yuzheng14/covro/actions/runs/42155049210)。首轮分片 3 的既有触屏未读 viewport 断言曾失败，自动重试同样失败；未改动代码或放宽断言，干净 main 与本 PR 在本地各重复两次通过，随后单独 job 重跑 75 项全部通过、整套工作流成功。首次失败记录保留在运行历史中。

## Native acceptance / 原生验收

The source and checked-in generated protocol were reviewed at exact 0.164.0 and 0.166.0 tags; links and wire semantics are in [the usage/protocol guide](file-references.md). The adapter fixture verifies that search receives only the server cwd, that abort sends an empty search with the same unique cancellation token and no roots, and that selected files use ordinary path text rather than Apps `mention` inputs.

已核对 0.164.0 与 0.166.0 精确 tag 源码及项目生成协议；依据见[操作与协议说明](file-references.md)。适配器 fixture 验证原生搜索和取消载荷，页面/服务验证文件转换为普通路径文本、技能保持 `skill` 身份，文件不使用 Apps `mention`。

With the user's explicit permission for isolated native acceptance, `scripts/verify-file-references.ts` ran the installed **0.166.0** binary with one temporary app-server/gateway, a fresh canonical workspace and home, and only a temporary copy of existing authentication. It copied no global configuration, history, skills or MCP. The temporary home (including credentials) and workspace were removed on completion. The existing user's Covro and default CLI were untouched.

经用户明确允许隔离原生验收后，使用已安装 **0.166.0**、一个临时 app-server/网关、独立真实路径工作区和 home，仅临时复用现有认证；未复制全局配置、历史、技能或 MCP。完成后清理工作区及包含认证的临时 home，未改动用户正在运行的 Covro 或默认 CLI。

Actual checks (no repository fixture or model stub):

- Chinese/space path fuzzy search, native 50-match limit, abort followed by successful search on the same app-server PID.
- Native unassigned draft search and session creation reuse exactly the server-reserved cwd.
- Production browser file selection; actual file deletion rejects dispatch and preserves both bound references; restoring the file permits explicit retry.
- The actual model reads both selected files and returns their hidden random tokens; a same-name decoy is not read. Token contents are absent from the prompt.
- Direct native `readThread` confirms one accepted user message containing quoted path text without the picker’s `@` markers. The failed pre-dispatch attempt remains a separate failed UI bubble under main's existing submission-display behavior.
- [Real desktop/390px selected-reference and completed-result screenshots were uploaded through Browser Use and verified on GitHub](https://github.com/yuzheng14/covro/pull/319#issuecomment-6675829660). Fixture multilingual screenshots remain separately labelled.

实际验证：中文/空格路径、原生 50 项限额、取消后同 PID 继续查询；未关联草稿与会话沿用服务器 cwd；真实删除导致派发前拒绝且保留两个引用，恢复后手动重试成功。真实模型返回两个只存在于所选文件中的随机令牌，同名诱饵未被读取；原生历史仅一条成功用户消息，含正确带引号路径且没有选择器 `@` 标记。main 原有机制保留的失败气泡与成功原生历史分别核对；桌面及 390px 均有真机截图。

Machine-readable evidence: [native results](file-references-results.json). Reproduce using an existing authenticated installation (this explicitly makes a model request):

```sh
node --import tsx scripts/verify-file-references.ts \
  --binary /path/to/installed/codex-0.166.0 \
  --output-dir /tmp/covro-file-reference-check --inference
```

0.164.0 was reviewed as the issue’s original source/protocol baseline, not rerun as a real inference target in this change. This work does not expand the project's verified-version manifest.

0.164.0 仅作为 Issue 原始源码/协议基线对照，本次不声称重跑了该版本真实推理，也不扩大已验证版本声明。

`@` references send file paths, not frozen file contents. All symlinks are intentionally excluded. Workspace images remain path references; use the existing image attachment flow for image input. Upstream fuzzy search may report traversal failures as empty results. Portable Node filesystem checks cannot eliminate parent-directory replacement races or guarantee files remain unchanged after validation. These boundaries are described in the bilingual guide.

文件引用传递路径而非内容快照，拒绝所有符号链接；服务器图片保持路径引用，图像输入沿用原图片附件。上游可能将遍历失败折叠为空结果。Node 可移植文件 API 的父目录替换竞态及验证后的文件变化不能完全消除，双语指南已说明。
