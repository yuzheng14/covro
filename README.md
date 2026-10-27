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

- 📱 **Follow tasks from any device.** Review changes, handle approvals, and answer questions on desktop or mobile. Tasks keep running when you close the page.
- 🗂️ **Keep projects and conversations together.** Start without a project, track parallel tasks, and resume or fork your Codex CLI conversations.
- 📖 **Read results while you chat.** Preview documents, diagrams, and code changes beside the conversation on desktop, or full-screen on mobile.
- 🔔 **Know when your attention is needed.** Enable browser notifications for completed work, questions, and approvals; keep the page open in a supported desktop browser.

Use **＋** in the message box to attach images from your phone or computer. Open the combined model control to choose the model, reasoning effort, Fast mode, and Plan/Execute mode. Use `/plan [task]` to select Plan mode or submit a planning task.

When the selected model is at capacity, Covro shows native retry progress and can make up to three additional attempts after 5, 10, and 20 seconds when Codex does not retry and no output or tool work has started. You can cancel, or choose another model and retry manually. See [retry behavior](docs/capacity-retry.md) for recovery boundaries.

Use `/review` to choose uncommitted changes, a base branch, a commit, or custom review instructions. Use `/init` to request a project contributor guide; an existing `AGENTS.md` is preserved.

See the [usage guide · 中文](docs/usage.zh-CN.md) for workflow details and controls.

Start a new conversation in the current workspace with **⌘ + Option + N** on macOS or **Ctrl + Alt + N** on Windows/Linux. The message box receives focus and existing drafts stay available. When the workspace has a recognized GitHub remote, the GitHub icon in the header opens its repository in a new tab. See [workspace details](docs/workspaces.md#open-the-github-repository) for remote selection rules.

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

`covro` starts in the background and prints the local address. Use `covro stop` to stop it. See [installation and service management](docs/distribution.md) for configuration, logs, login auto-start, macOS credential diagnostics, and release channels.

Open **<http://127.0.0.1:8787>** and click **＋** beside **Unassigned** to send your first task. Or use **Add project** to import a host directory or clone a Git repository. See [project setup](docs/project-clone.md) and [conversation workspaces](docs/workspaces.md) for directory options.

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

Use the update panel to check versions and choose stable, beta, or dev. Beta and Dev also receive newer stable releases. **macOS and Linux npm global installations** support managed upgrades from this panel or `covro update`; other installations use their original update method.

Automatic installation is off by default and requires a verified Codex combination. Unverified combinations need explicit confirmation; unknown versions, missing or invalid compatibility declarations, and explicitly unsupported combinations block managed upgrades. Covro does not upgrade Codex CLI. See [updates and recovery](docs/distribution.md) for commands, compatibility checks, and backups.

DB Schema **7** is tracked separately from the application version; older applications cannot open newer databases. Backups cover Covro’s database and service configuration, excluding project files, Codex history, and credentials. Restore requires stopping the service; see [backups](docs/backups.md) and [database compatibility](docs/database.md).

## Your computer, your workspace

Covro connects to your existing CLI through `codex app-server`. Tasks, projects, and Codex history stay on the host computer, using your Codex login and configuration. Login credentials are not copied into the browser; Codex still uses its configured model provider.

Covro is for a single user. The [Shell panel](docs/shell.md) runs non-interactive commands using Codex’s configured sandbox. An interactive terminal, file editor, Git GUI, and multi-user team management are outside the current scope.

## Development and contribution

```sh
pnpm format:check
pnpm typecheck
pnpm lint
pnpm test
pnpm build
pnpm test:e2e
```

Browser tests require the Chromium version used by the existing Playwright dependency. Tests and CI use explicit fixtures; they do not send real model requests.

Use `pnpm format` to fix formatting; PR titles follow Conventional Commits. See [contribution and release conventions](docs/contributing.md).

Found a problem or have an idea? [Open an issue](https://github.com/yuzheng14/covro/issues) with your OS, Node.js and Codex versions, installation method, and steps to reproduce. Small, focused PRs are welcome; update both READMEs when changing user-facing facts or setup instructions.

<a id="documentation"></a>

## 📚 Documentation

| Guide                                                                  | Contents                                                                |
| ---------------------------------------------------------------------- | ----------------------------------------------------------------------- |
| [Detailed usage · 中文](docs/usage.zh-CN.md)                           | Projects, conversations, approvals, notifications, images, and recovery |
| [Deployment](docs/deployment.md)                                       | Local access, Tailscale, and Cloudflare Access                          |
| [Distribution](docs/distribution.md)                                   | CLI, services, data locations, upgrades, and repair                     |
| [Compatibility](docs/compatibility.md)                                 | Verified Codex versions and behavior boundaries                         |
| [Slash commands](docs/slash-commands.md)                               | Supported commands and usage                                            |
| [Architecture](docs/architecture.md)                                   | How the gateway, Codex adapter, and browser fit together                |
| [Verification](docs/verification.md)                                   | Test coverage and recorded live checks                                  |
| [Projects](docs/project-clone.md) · [Workspaces](docs/workspaces.md)   | Importing, cloning, and conversation directories                        |
| [Languages](docs/i18n.md) · [History loading](docs/session-history.md) | Interface language and conversation loading                             |
| [Shell](docs/shell.md)                                                 | Command execution and sandbox limits                                    |
| [Backups](docs/backups.md) · [Database](docs/database.md)              | Snapshot scope, compatibility, and offline recovery                     |
| [Contributing](docs/contributing.md) · [Releases](docs/releases.md)    | Formatting, PRs, and publishing                                         |
| [Brand assets](docs/brand.md)                                          | Editable SVG logo and wordmarks                                         |

## License

[MIT](LICENSE). Covro is an independent project and is not affiliated with OpenAI.
