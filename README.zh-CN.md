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

- 📱 **随时随地跟进任务。** 用电脑或手机查看改动、处理审批、回答问题。关闭页面，任务仍会继续。
- 🗂️ **集中管理项目与会话。** 无需项目即可开始任务，在一个工作台查看并行进展，接续或 Fork Codex CLI 会话。
- 📖 **一边看产出，一边讨论。** 电脑上将文档、图表和代码变更与会话并排阅读，手机上使用全屏阅读器。
- 🔔 **及时收到待办提醒。** 开启浏览器通知，在工作结束、需要回答或审批时收到提醒；需在支持通知的桌面浏览器中保持页面运行。

操作方式与使用细节见[使用指南](docs/usage.zh-CN.md)。

在当前工作区新建会话：macOS 按 **⌘ + Option + N**，Windows/Linux 按 **Ctrl + Alt + N**。输入框会自动获得焦点，已有草稿继续保留。工作区有可识别的 GitHub remote 时，点击顶部 GitHub 图标即可在新标签页打开仓库；remote 选择规则见[工作区说明](docs/workspaces.md#快捷打开-github-仓库)。

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

`covro` 默认在后台启动并输出本机访问地址，使用 `covro stop` 停止。配置、日志、登录自启、macOS 凭证诊断和版本渠道见[安装与服务管理](docs/distribution.md)。

打开 **<http://127.0.0.1:8787>**，点击 **未关联项目** 右侧的 **＋** 即可发送第一条任务。也可通过 **添加项目** 导入主机目录或克隆 Git 仓库。目录选项见[项目配置](docs/project-clone.md)和[会话工作目录](docs/workspaces.md)。

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

在更新面板检查版本，选择稳定版、预览版或开发版；预览版和开发版也会接收更新的稳定版本。**macOS 和 Linux 的 npm 全局安装**支持在此面板或通过 `covro update` 受管升级；其他安装方式沿用原更新方法。

自动安装默认关闭，且只接受已验证的 Codex 组合。未验证组合需要明确确认；版本未知、兼容声明缺失或无效、明确不支持的组合会阻止受管升级。Covro 不会升级 Codex CLI。完整命令、兼容检查和备份说明见[更新与恢复](docs/distribution.md)。

DB Schema **7** 独立于应用版本管理，旧应用不能打开更新的数据库。备份覆盖 Covro 数据库和服务配置，不包含项目文件、Codex 历史或凭据。恢复需要停服，详见[备份与恢复](docs/backups.md)和[数据库兼容规则](docs/database.md)。

## 你的电脑，你的工作台

Covro 通过 `codex app-server` 连接已有 CLI，沿用你的 Codex 登录与配置。任务在运行服务的电脑上执行，项目和 Codex 历史也留在那里；登录凭据不会复制到浏览器，Codex 仍会访问你配置的模型提供方。

Covro 面向单用户。[Shell 面板](docs/shell.md)沿用 Codex 配置的沙箱执行非交互命令。交互终端、文件编辑器、Git 图形界面与多人团队管理不在当前范围内。

## 开发与参与

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

浏览器测试需要现有 Playwright 依赖所对应的 Chromium。测试与 CI 使用明确的测试夹具，不发起真实模型请求。

使用 `pnpm format` 修复格式，PR 标题遵循 Conventional Commits，详见[开发与发版约定](docs/contributing.md)。

遇到问题或有想法，欢迎[提交 Issue](https://github.com/yuzheng14/covro/issues)，附上操作系统、Node.js 与 Codex 版本、安装方式和复现步骤。也欢迎范围明确的小 PR；修改面向使用者的事实或安装步骤时，请同步更新两份 README。

<a id="文档导航"></a>

## 📚 文档导航

| 指南                                                           | 内容                                 |
| -------------------------------------------------------------- | ------------------------------------ |
| [详细使用指南](docs/usage.zh-CN.md)                            | 项目、会话、审批、通知、图片和恢复   |
| [部署](docs/deployment.md)                                     | 本机、Tailscale 与 Cloudflare Access |
| [分发](docs/distribution.md)                                   | CLI、服务、数据位置、升级与修复      |
| [兼容性](docs/compatibility.md)                                | 已验证的 Codex 版本与行为边界        |
| [Slash 命令](docs/slash-commands.md)                           | 支持的命令和用法                     |
| [架构](docs/architecture.md)                                   | 网关、Codex 适配器与浏览器的协作方式 |
| [验证记录](docs/verification.md)                               | 测试范围与真实环境检查记录           |
| [项目](docs/project-clone.md) · [工作目录](docs/workspaces.md) | 导入、克隆与会话目录                 |
| [语言](docs/i18n.md) · [历史加载](docs/session-history.md)     | 界面语言与会话加载                   |
| [Shell](docs/shell.md)                                         | 命令执行与沙箱限制                   |
| [备份](docs/backups.md) · [数据库](docs/database.md)           | 快照范围、兼容性与停服恢复           |
| [开发约定](docs/contributing.md) · [发版](docs/releases.md)    | 格式、PR 与发布流程                  |
| [品牌素材](docs/brand.md)                                      | 可编辑的 SVG 图标与完整标识          |

## 许可证

[MIT](LICENSE)。Covro 是独立项目，与 OpenAI 无隶属关系。
