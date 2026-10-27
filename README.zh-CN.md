<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/covro-logo-dark.svg" />
    <img src="docs/assets/covro-logo.svg" alt="Covro" width="266" height="64" />
  </picture>
</p>

<h1 align="center">在浏览器里，用你的 Codex CLI。</h1>

<p align="center">
  <strong>Covro 是 Codex CLI 的自部署 Web UI。</strong><br />
  在桌前发起任务，用手机查看改动、处理审批，接着推进下一步。
</p>

<p align="center"><strong>自行部署 · 电脑与手机 · 沿用 Codex 登录 · MIT 开源</strong></p>

<p align="center">
  <a href="#开始使用">🚀 开始使用</a> ·
  <a href="#你可以做什么">✨ 功能介绍</a> ·
  <a href="#从其他设备访问">🌐 远程访问</a> ·
  <a href="README.md">English</a>
</p>

![Covro 桌面工作台：会话与 Markdown 文档并排阅读](docs/assets/workspace-desktop.png)

<p align="center"><sub>截图来自实际运行的应用，使用示例项目与测试夹具生成的会话。</sub></p>

<a id="你可以做什么"></a>

## ✨ 你可以做什么

- 📱 **随时随地跟进任务。** 用电脑或手机查看改动与[账户额度](docs/account-usage.md)、处理审批和回答问题。关闭页面，任务仍会继续；执行中也能调整会话配置。
- 🗂️ **集中管理项目与会话。** 无需项目即可开始任务，在一个工作台查看并行进展，接续或 Fork Codex CLI 会话。
- 📖 **一边看产出，一边讨论。** 电脑上将文档、图表和代码变更与会话并排阅读，手机上使用全屏阅读器。新回复实时到达时，已加载的历史正文保持完整。
- 🔔 **及时收到待办提醒。** 在支持通知的桌面或 Android 浏览器中，接收工作结束、需要回答或审批的提醒。需保持页面在线；页面冻结或关闭期间不推送通知。

操作、快捷键和命令用法见[使用指南](docs/usage.zh-CN.md)、[Slash 命令说明](docs/slash-commands.md)和[配置生效时机](docs/session-live-settings.md)。

<details>
  <summary><strong>📱 手机上也能舒服地使用</strong></summary>
  <img src="docs/assets/workspace-mobile.png" alt="手机屏幕上的 Covro 会话" width="320" />
</details>

<a id="开始使用"></a>

## 🚀 开始使用

需要 **Node.js 24.x，版本不低于 24.19**，以及已经安装、登录的 **Codex CLI**。界面支持简体中文、英语、日语和韩语。

<!-- codex-compatibility:start -->

推荐 Codex CLI：**0.164.0**。已验证版本：`0.164.0`。

<!-- codex-compatibility:end -->

其他 Codex 版本及使用确认要求见[兼容性说明](docs/compatibility.md)。

<a id="npm-安装"></a>

### 📦 npm 安装

```sh
npm install -g @covro/covro
covro
```

`covro` 在后台启动，使用 `covro stop` 停止。配置、日志与登录自启见[安装指南](docs/distribution.md)。

打开 **<http://127.0.0.1:8787>**，点击 **未关联项目** 旁的 **＋** 开始任务，或通过 **添加项目** [导入目录或克隆仓库](docs/project-clone.md)。

<a id="从源码运行"></a>

### 🛠️ 从源码运行

参与开发或从源码部署时，使用 **pnpm 12.11.2**：

```sh
git clone https://github.com/yuzheng14/covro.git
cd covro
pnpm install --frozen-lockfile
cp config.example.json config.local.json
pnpm build
pnpm start -- --config ./config.local.json
```

本地开发可以改用 `pnpm dev`，打开 <http://127.0.0.1:5173>。

<a id="从其他设备访问"></a>

## 🌐 从其他设备访问

新安装默认只监听回环地址。从其他设备访问时，请按[部署指南](docs/deployment.md)配置 **Tailscale Serve** 或 **Cloudflare Tunnel 与 Access**。

运行服务的电脑需要保持唤醒并在线。远程添加项目时，填写的仍是这台电脑上的目录。

## 更新与版本渠道

在更新面板或通过 `covro update` 选择稳定、预览或开发渠道。受管升级支持 **macOS 和 Linux 的 npm 全局安装**，其他安装方式沿用原更新方法。默认 Node 变更后，可切换到已安装全局 Covro 的受支持环境，Covro 同版本也可迁移。自动安装默认关闭，且只接受已验证的 Codex 组合；未验证组合需明确确认。Covro 不会升级 Codex CLI。详见[更新与恢复](docs/distribution.md)。

## 你的电脑，你的工作台

Covro 通过 `codex app-server` 连接已有 CLI，沿用你的 Codex 登录与配置。任务在运行服务的电脑上执行，项目和 Codex 历史也留在那里；登录凭据不会复制到浏览器，Codex 仍会访问你配置的模型提供方。

Covro 面向单用户。[Shell 面板](docs/shell.md)沿用 Codex 配置的沙箱执行非交互命令。交互终端、文件编辑器、Git 图形界面与多人团队管理不在当前范围内。

DB Schema **7** 独立于应用版本，旧应用不能打开更新的数据库。备份只覆盖 Covro 数据库和服务配置，不包含项目文件、Codex 历史或凭据；恢复需停服。详见[备份](docs/backups.md)与[数据库兼容规则](docs/database.md)。

## 开发与参与

开发环境、检查命令与 PR 约定见[贡献指南](docs/contributing.md)。欢迎[提交 Issue](https://github.com/yuzheng14/covro/issues) 或范围明确的 PR；面向使用者的变更需同步更新两份 README。

<a id="文档导航"></a>

## 📚 文档导航

| 主题       | 指南                                                                                                                                                              |
| ---------- | ----------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| 日常使用   | [使用指南](docs/usage.zh-CN.md) · [命令](docs/slash-commands.md) · [技能与显式引用](docs/skills.md) · [Shell](docs/shell.md) · [容量重试](docs/capacity-retry.md) |
| 项目与会话 | [导入与克隆](docs/project-clone.md) · [工作目录](docs/workspaces.md) · [历史加载](docs/session-history.md)                                                        |
| 安装与访问 | [安装与更新](docs/distribution.md) · [部署](docs/deployment.md) · [界面语言](docs/i18n.md)                                                                        |
| 数据与兼容 | [备份](docs/backups.md) · [数据库](docs/database.md) · [Codex 兼容性](docs/compatibility.md)                                                                      |
| 开发与发布 | [贡献](docs/contributing.md) · [架构](docs/architecture.md) · [验证](docs/verification.md) · [发版](docs/releases.md) · [品牌素材](docs/brand.md)                 |

## 许可证

[MIT](LICENSE)。Covro 是独立项目，与 OpenAI 无隶属关系。
