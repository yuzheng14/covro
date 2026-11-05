# File reference verification / 文件引用验证

Date: 2026-11-05. Base: `origin/main` at `97b0eb8`. Project recommended/verified Codex: **0.166.0**. The default installed CLI is still **0.164.0**; this work does not upgrade it or change the user's running Covro instance.

日期：2026-11-05。基于 `origin/main` 的 `97b0eb8`；项目推荐/已验证版本为 **0.166.0**，本机默认 CLI 仍是 **0.164.0**，本次不升级全局 CLI 或改动正在运行的 Covro 实例。

## Checks / 检查

- TypeScript, ESLint, Prettier, production build, compatibility/README synchronization and `git diff --check` pass. No external dependency, browser or tool was installed; package and lock files are unchanged. Build retains the existing large-chunk advisory.
- Full unit/integration suite: **1520 passed, 1 existing skipped**. The first sandboxed run hit loopback/socket `EPERM`; the complete rerun with local socket access passed. File tests cover project/session cwd, unassigned draft allocation, unavailable/removed nested registrations, forged draft IDs, traversal, symlinks, range/cwd mismatches, disappearance, unreadable files, limits, offline/obsolete runtimes and native cancellation request shape.
- **90 browser tests passed** across composer layout/keyboard, files, skills, images, slash commands, first messages, mobile input and unassigned workspaces. The final file-query generation guard is additionally checked by rerunning the **10 file acceptance tests**.
- Real rendered pages use the production frontend and repository-owned subprocess fixture, on isolated ports. File acceptance checks include registered and unassigned first sends, native-form path text in received history, multiple Chinese/space/same-name paths, independent skill identity, browser images, file-only steering, atomic deletion/undo, query/workspace races, controlled-update draft recovery, errors/offline draft retention, literal `@`, IME and mobile button/touch input.
- Desktop and 390px screenshots cover English, 简体中文, 日本語 and 한국어, plus bound references with an image and a deleted-file error retaining the draft. Screenshot banners explicitly identify fixture simulation. PR screenshot delivery must be checked in the actual GitHub comment; a local PNG alone is not delivery.

类型、lint、格式、构建、兼容性/双语 README 校验及 diff 检查通过，未新增依赖或下载工具。全量 **1520 项通过、1 项原有跳过**；最初沙箱阻止本地端口/套接字，开放测试所需回环访问后的全量重跑通过。**90 项浏览器回归通过**；最后的查询代次保护另重跑 **10 项文件验收**。截图来自生产前端的真实页面，后端明确使用仓库 fixture，不冒充真实模型推理；PR 评论实际上传/显示情况需以 GitHub 评论为准。

## Native evidence and remaining boundary / 原生依据与待完成部分

The source and checked-in generated protocol were reviewed at exact 0.164.0 and 0.166.0 tags; links and wire semantics are in [the usage/protocol guide](file-references.md). The adapter fixture verifies that search receives only the server cwd, that abort sends an empty search with the same unique cancellation token and no roots, and that selected files use ordinary path text rather than Apps `mention` inputs.

已核对 0.164.0 与 0.166.0 精确 tag 源码及项目生成协议；依据见[操作与协议说明](file-references.md)。适配器 fixture 验证原生搜索和取消载荷，页面/服务验证文件转换为普通路径文本、技能保持 `skill` 身份，文件不使用 Apps `mention`。

**Not yet performed:** a new real 0.166.0 app-server search/cancellation run or actual model reading of the selected files. The task explicitly prohibits launching another app-server or replacement implementation session. The current tool connection does not expose raw file-search RPC on the existing managed instance. An exception was requested for an isolated native acceptance run; until explicitly approved, fixture results must not be described as real Codex/model verification. Keep the implementation PR draft while this acceptance gap remains.

**尚未完成：** 新启动真实 0.166.0 app-server 的原生搜索/取消及模型读取文件结果验证。用户明确禁止额外 app-server 或替代实现会话，而当前工具未开放现有受管实例的原始文件搜索 RPC。已请求仅用于隔离验收的例外许可，获明确许可前不执行，也不把 fixture 写成真实 Codex/推理验证；这一验收缺口未补齐时保留草稿 PR。

`@` references send file paths, not frozen file contents. All symlinks are intentionally excluded. Workspace images remain path references; use the existing image attachment flow for image input. Upstream fuzzy search may report traversal failures as empty results. Portable Node filesystem checks cannot eliminate parent-directory replacement races or guarantee files remain unchanged after validation. These boundaries are described in the bilingual guide.

文件引用传递路径而非内容快照，拒绝所有符号链接；服务器图片保持路径引用，图像输入沿用原图片附件。上游可能将遍历失败折叠为空结果。Node 可移植文件 API 的父目录替换竞态及验证后的文件变化不能完全消除，双语指南已说明。
