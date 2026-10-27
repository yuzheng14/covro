# Account usage / 账户额度

Open **Settings → Account usage** in the sidebar. The panel reads the account of the running Codex instance; switching conversations does not change its scope. It shows independent quota groups, primary/secondary windows, reported plan/model names, used and remaining percentages, and reset times in the interface language and browser time zone. Credits, individual spend limits, backend permission for included usage, and earned-reset counts appear only when reported. Balances and spend values retain their reported units; Covro does not calculate bills.

**Refresh** reads the account and its quotas again. The displayed data time is the last successful complete read. A failed refresh preserves that snapshot with an explicit failure message; an offline connection hides the snapshot. Account and app-server changes invalidate the previous account's data and in-flight reads. A passed reset time asks you to refresh; it never resets a progress bar or claims quota has recovered. Unlimited credits apply only to the reported credits field, not to other quota windows. Missing fields remain unknown, rather than becoming zero or unlimited.

This is a read-only view. It does not sign in, change credentials, buy credits, redeem resets, or expose billing controls. It does not call `account/usage/read` or add `/usage`. Thread tokens and context size are separate session metrics tracked in #266.

## 中文

从侧栏打开「设置 → 账户额度」。数据属于当前运行的 Codex 实例，不随会话切换。面板分别展示上游报告的各额度分组、主/次窗口、计划与模型名称、已用/剩余比例及重置时间。时间沿用界面语言和浏览器时区。Credits、个人支出限制、订阅内用量许可和已获重置次数仅在上游报告时显示；余额与支出值保留原单位，不推算账单。

「刷新」重新读取账户与额度。数据时间代表最近一次完整读取成功的时间；刷新失败会保留该次快照并标明失败，离线则隐藏旧快照。账户或 app-server 变化会清空旧数据，并丢弃过期请求结果。重置时间经过后提示刷新确认，不自动归零或宣称恢复。无限 credits 只适用于该 credits 字段，不代表其他窗口无限；缺失字段保持未知，不当作零或无限。

此面板只读，不提供登录、凭据修改、购买、重置兑换或账单管理。不调用 `account/usage/read`，不新增 `/usage`；会话 token 与上下文由 #266 独立跟踪。

## Protocol and verification scope

The supported baseline is **Codex 0.164.0**, as declared in `package.json`. The integration uses `account/read` with `refreshToken: false`, `account/rateLimits/read`, `account/updated`, and `account/rateLimits/updated`. The checked-in types were generated from that exact binary; see the [0.164.0 protocol audit](codex-0.164.0-protocol.md) and [official app-server account documentation](https://learn.chatgpt.com/docs/app-server#6-rate-limits-chatgpt). Sparse rolling notifications trigger a full read instead of replacing other quota groups. The legacy bucket is deduplicated against the multi-bucket map. Account email, account ID, upsell payloads, and upstream error diagnostics are excluded from the public quota snapshot.

- Repository fixture tests cover protocol reads and notifications, multiple groups, unsupported methods, signed-out accounts, missing fields, unlimited/depleted credits, exhausted windows, refresh failures, identity races, offline state, and four-language keyboard/narrow-screen rendering.
- Verified the installed real **0.164.0** binary with a fresh temporary `CODEX_HOME`, without credentials or inference: `account/read` returned `account: null, requiresOpenaiAuth: true`; `account/rateLimits/read` returned `-32600` (account authentication required), confirming the method is recognized. Live authenticated quota values and actual service resets were not verified.
