<p align="center">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="docs/assets/covro-logo-dark.svg" />
    <img src="docs/assets/covro-logo.svg" alt="Covro" width="266" height="64" />
  </picture>
</p>

<h1 align="center">Codex CLI. Now in your browser.</h1>

<p align="center">
  <strong>Covro is a self-hosted Web UI for Codex CLI.</strong><br />
  Start a task at your desk. Review the changes, approve the next step, and keep it moving from your phone.
</p>

<p align="center"><strong>Self-hosted · Desktop & mobile · Your existing Codex login · MIT</strong></p>

<p align="center">
  <a href="#get-started">🚀 Get started</a> ·
  <a href="#what-you-can-do">✨ Features</a> ·
  <a href="#access-from-another-device">🌐 Remote access</a> ·
  <a href="README.zh-CN.md">简体中文</a>
</p>

![Covro desktop workspace with a conversation and a Markdown document side by side](docs/assets/workspace-desktop.png)

<p align="center"><sub>Captured from the running app with sample projects and fixture-generated conversations.</sub></p>

<a id="what-you-can-do"></a>

## ✨ What you can do

- 📱 **Follow tasks from any device.** Review changes, handle approvals, answer questions, and check [account quotas](docs/account-usage.md) on desktop or mobile. Tasks keep running when you close the page.
- 🗂️ **Keep projects and conversations together.** Start without a project, track parallel tasks, and resume or fork your Codex CLI conversations.
- 📖 **Read results while you chat.** Preview documents, diagrams, and code changes beside the conversation on desktop, or full-screen on mobile. Loaded history stays complete as new responses stream in.
- 🔔 **Know when your attention is needed.** Enable browser notifications for completed work, questions, and approvals in a supported desktop or Android browser. Keep the page online; notifications are not pushed while it is frozen or closed.

Find controls, shortcuts, and supported commands in the [usage guide · 中文](docs/usage.zh-CN.md) and [command guide](docs/slash-commands.md).

<details>
  <summary><strong>📱 A workspace that fits your phone</strong></summary>
  <img src="docs/assets/workspace-mobile.png" alt="Covro conversation on a phone-sized screen" width="320" />
</details>

<a id="get-started"></a>

## 🚀 Get started

You need **Node.js 24.19 or later in the 24.x line** and an installed, signed-in **Codex CLI**. The interface supports Simplified Chinese, English, Japanese, and Korean.

<!-- codex-compatibility:start -->

Recommended Codex CLI: **0.164.0**. Verified versions: `0.164.0`.

<!-- codex-compatibility:end -->

For other Codex versions and confirmation requirements, see [compatibility](docs/compatibility.md).

<a id="npm-installation"></a>

### 📦 npm installation

```sh
npm install -g @covro/covro
covro
```

`covro` runs in the background; stop it with `covro stop`. See the [installation guide](docs/distribution.md) for configuration, logs, and login auto-start.

Open **<http://127.0.0.1:8787>** and click **＋** beside **Unassigned** to start a task, or use **Add project** to [import a directory or clone a repository](docs/project-clone.md).

<a id="run-from-source"></a>

### 🛠️ Run from source

For local development or source deployments, use **pnpm 12.11.2**:

```sh
git clone https://github.com/yuzheng14/covro.git
cd covro
pnpm install --frozen-lockfile
cp config.example.json config.local.json
pnpm build
pnpm start -- --config ./config.local.json
```

For local development, run `pnpm dev` instead and open <http://127.0.0.1:5173>.

<a id="access-from-another-device"></a>

## 🌐 Access from another device

Fresh installations listen on loopback only. To connect from another device, configure **Tailscale Serve** or **Cloudflare Tunnel with Access** using the [deployment guide](docs/deployment.md).

The host computer must stay awake and online. When adding projects remotely, enter directories on that computer.

## Updates and release channels

Choose stable, beta, or dev in the update panel or with `covro update`. Managed upgrades support **macOS and Linux npm global installations**; other installations use their original update method. Automatic installation is off by default and requires verified Codex compatibility; unverified combinations need explicit confirmation. Covro does not upgrade Codex CLI. See [updates and recovery](docs/distribution.md).

## Your computer, your workspace

Covro connects to your existing CLI through `codex app-server`. Tasks, projects, and Codex history stay on the host computer, using your Codex login and configuration. Login credentials are not copied into the browser; Codex still uses its configured model provider.

Covro is for a single user. The [Shell panel](docs/shell.md) runs non-interactive commands using Codex’s configured sandbox. An interactive terminal, file editor, Git GUI, and multi-user team management are outside the current scope.

DB Schema **7** is independent of the application version; older applications cannot open newer databases. Backups cover only Covro’s database and service configuration, excluding project files, Codex history, and credentials. Restore requires stopping the service. See [backups](docs/backups.md) and [database compatibility](docs/database.md).

## Development and contribution

See the [contribution guide](docs/contributing.md) for development setup, checks, and PR conventions. [Open an issue](https://github.com/yuzheng14/covro/issues) or send a focused PR; update both READMEs when changing user-facing facts.

<a id="documentation"></a>

## 📚 Documentation

| Topic                      | Guides                                                                                                                                                                            |
| -------------------------- | --------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Everyday use               | [Usage · 中文](docs/usage.zh-CN.md) · [Commands](docs/slash-commands.md) · [Shell](docs/shell.md) · [Capacity retries](docs/capacity-retry.md)                                    |
| Projects and conversations | [Import and clone](docs/project-clone.md) · [Workspaces](docs/workspaces.md) · [History loading](docs/session-history.md)                                                         |
| Setup and access           | [Install and update](docs/distribution.md) · [Deployment](docs/deployment.md) · [Interface languages](docs/i18n.md)                                                               |
| Data and compatibility     | [Backups](docs/backups.md) · [Database](docs/database.md) · [Codex compatibility](docs/compatibility.md)                                                                          |
| Development and releases   | [Contributing](docs/contributing.md) · [Architecture](docs/architecture.md) · [Verification](docs/verification.md) · [Releases](docs/releases.md) · [Brand assets](docs/brand.md) |

## License

[MIT](LICENSE). Covro is an independent project and is not affiliated with OpenAI.
