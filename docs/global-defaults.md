# Session defaults

[简体中文](global-defaults.zh-CN.md)

Open **Settings → Session defaults** to select the default permission mode, model, and reasoning effort. Saving writes to the connected Codex user configuration; other clients using that environment may share it.

Models and supported efforts come from the connected Codex global provider, separately from project or historical-session catalogs. Permission availability also comes from Codex. Changing models retains a supported effort or resets it to the model default. Keeping the current permission mode preserves custom permission configuration. Selecting a named built-in mode writes its standard sandbox, approval policy, and reviewer and clears existing named-profile and extra-workspace overrides.

Defaults apply to future new conversations without hot-reloading existing ones or replacing explicit draft selections. Project configuration may override user defaults. Writes are batched through Codex, with version checks when available. The editor rereads Codex after a successful save. An RPC timeout or disconnect requires Reload to confirm the result; writes are never retried automatically. Configuration saves create no persistent task receipts, so an uncertain result cannot keep backups or upgrades blocked. Only in-flight writes hold maintenance, and shutdown waits for them to settle. Reopening Settings also reads fresh configuration. Higher-priority overrides are reported separately. Open tabs refresh new-draft defaults after saving.

When merged configuration contains both a named permission profile and legacy sandbox fields, Covro leaves the preset undetermined rather than assuming a profile wins. The new-conversation composer shows **Cannot determine mode**, and the global defaults editor preserves the current permission configuration. Once a conversation starts, its actual Codex-reported boundary determines the displayed mode. Covro does not rewrite configuration to resolve this ambiguity. See [Codex permission mechanisms](https://learn.chatgpt.com/docs/permissions).
