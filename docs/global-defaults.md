# 会话默认设置

在「设置 → 会话默认设置」配置默认权限模式、默认模型和默认推理强度，点击「保存默认设置」后写入 Covro 所连接的 Codex 用户配置。该配置也可能被使用同一 Codex 环境的其他客户端读取。

- 模型列表和推理强度来自当前 Codex。更换模型时保留仍受支持的推理强度，否则改为使用模型默认强度；选择 Codex 默认模型时也使用其默认强度。
- 权限模式提供请求批准、帮我批准、完全访问和只读。可用条件由当前 Codex、所选模型和受管要求决定，不可用时会说明原因。选择「保留当前 / Codex 默认」不会改写现有权限配置，适合保留自定义权限。
- 选择某个明确权限模式时，写入该模式的标准沙箱、审批策略和审核方，并清除已有命名权限 profile 和工作区额外授权，以免混合成含义不同的自定义模式。
- 新默认值供后续新会话使用，不热更新已有会话，也不会覆盖输入区里已明确选择的选项。项目目录中的配置仍可能覆盖用户默认值。
- 保存使用一次原生配置批量写入；有版本信息时检测并发修改。保存结果不确定时先重新读取核对，避免直接重复提交。配置受更高优先级来源覆盖时单独提示。
- 当前浏览器以及已打开的其他页面会刷新新草稿的默认值。刷新后编辑器从服务重新读取，不依赖浏览器本地存储。

# Session defaults

Open **Settings → Session defaults** to select the default permission mode, model, and reasoning effort. Saving writes to the connected Codex user configuration; other clients using that environment may share it.

Models, supported efforts, and permission availability come from Codex. Changing models retains a supported effort or resets it to the model default. Keeping the current permission mode preserves custom permission configuration. Selecting a named built-in mode writes its standard sandbox, approval policy, and reviewer and clears existing named-profile and extra-workspace overrides.

Defaults apply to future new conversations without hot-reloading existing ones or replacing explicit draft selections. Project configuration may override user defaults. Writes are batched through Codex, with version checks when available. Reload to verify uncertain results; higher-priority overrides are reported separately. Open tabs refresh new-draft defaults after saving.
