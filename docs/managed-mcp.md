# Covro tools for managed Codex sessions

Covro exposes MCP tools to the `codex app-server` process it starts. They cover
Covro business workflows that should not be performed by starting another Codex
process. Native Codex file, shell, search, and other tools remain the normal entry
points for their existing capabilities.

## Tools

| Tool             | Input                                                                     | Result                                                                                                    |
| ---------------- | ------------------------------------------------------------------------- | --------------------------------------------------------------------------------------------------------- |
| `list_projects`  | Empty object                                                              | `projects`: registered `project_id`, `name`, canonical `path`, `available`, and an error when unavailable |
| `create_session` | Required `project_id` and non-blank `prompt`; optional UUID `request_key` | Operation status, retry key, stage, and known thread/turn IDs and Covro URL                               |

Call `list_projects` first and match the intended directory before choosing its
project ID. `create_session` rechecks the registration and directory; it does not
accept an arbitrary `cwd` or create an unassigned workspace. The initial prompt is
required, limited to 100,000 characters, and submitted without trimming its
contents.

The gateway creates the conversation through its existing managed app-server and
then submits the prompt through the normal turn workflow. Project ownership,
configuration, compatibility confirmation, execution markers, approvals, history
visibility, and browser updates use the same services as the UI. The tool returns
after submission is acknowledged; it does not wait for the new task to finish.

## Current-session loops

| Tool          | Input                                                                                                          | Result                                                                 |
| ------------- | -------------------------------------------------------------------------------------------------------------- | ---------------------------------------------------------------------- |
| `list_loops`  | Empty object                                                                                                   | Loops in the current session, with versions, status and next run times |
| `create_loop` | `prompt`, optional `interval_minutes` and UUID `request_key`                                                   | Operation receipt and created loop                                     |
| `update_loop` | `loop_id`, `version`, and `action`; optional UUID `request_key`. Supply `interval_minutes` for `set_interval`. | Operation receipt and updated loop                                     |

Call `list_loops` for the current version before updating a loop. Use `pause`,
`resume`, `cancel`, or `set_interval`. Supply a whole number of minutes between
1 and 1440 for a fixed cadence. Omit the interval in `create_loop` to use
adaptive scheduling. The normal Codex policy governs tool approval.

An interval edit starts a new wait from the edit. For a fixed loop, it sets the
ongoing cadence. For an adaptive loop, it sets the next check once and subsequent
rounds can choose their own intervals again. A late decision from a turn that
was already running yields to the explicit schedule. Adjusting or cancelling a
loop leaves the current turn running. Edits use the same persisted state and
optimistic version as the Web controls. Refresh with `list_loops` after
`LOOP_CONFLICT` before attempting a new change.

Use the returned `request_key` with identical input to read the receipt from a
new tool call in the same session. Covro generates a key from the native call
when it is omitted. MCP mutations are stored as `loop.create.mcp` and
`loop.control.mcp`. Logs link the receipt to the calling turn.

## Session creation retry and failure behavior

Codex supplies `threadId` and `callId` in MCP request metadata. Covro derives a
stable operation key from those values when `request_key` is omitted. Other MCP
clients must supply a UUID `request_key` explicitly. This key is returned on both
successful and failed operation receipts.

To inspect or retry the same intended operation, call `create_session` with the
same key, project ID, and prompt. The persisted receipt is returned without
recreating the session or resending its prompt. Reusing a key with different
input returns `OPERATION_CONFLICT`. A fresh key means a new intended session.

`status: acknowledged` and `stage: submitted` mean that the initial prompt was
accepted, not that the task completed. If submission fails after creation, the
response retains the existing thread ID and URL with `stage: created`. A lost
receipt or restart during dispatch returns `unknown`/`RESULT_UNKNOWN`; do not use
a fresh key to automatically create another conversation. The original child
operation receipts preserve known thread and turn IDs across gateway restarts.

## Registration and access boundary

The transport is MCP Streamable HTTP on a separate `127.0.0.1` listener with an
OS-assigned port. It supports normal MCP initialization, tool discovery and
calls; it is not a route on the browser's HTTP server or a public tunnel endpoint.

The gateway injects a server entry through app-server `-c` arguments. Its name has
an instance-specific `covro_` suffix to avoid merging with an existing user MCP
entry. Neither global nor project Codex/MCP configuration is written. Independently started CLI, IDE and
app-server processes do not automatically obtain this entry, including when they
resume a conversation created in Covro.

The loop tools are advertised only when the request carries the bearer credential
injected into the managed app-server process environment. Before each operation,
Covro matches the request's thread ID and call ID, tool name, and arguments to a
live `item/started` notification from that app-server's stdio connection. It
checks the active execution marker, Codex epoch, and workspace ownership before
accessing the loop. Copying a conversation ID into a request does not grant
access. A call without matching live context returns `MCP_SESSION_REQUIRED`.

The existing project and session-creation tools retain their loopback access
rules. Host and Origin validation and body limits apply to all tools. Local users
with full access to Covro's processes or files remain inside the host trust
boundary. Browser/API authentication and Cloudflare Access are unchanged.

The endpoint closes with the gateway. The process-only entry is reapplied when
the managed app-server restarts. Internal title and recap threads retain their
existing MCP/tool isolation. No user-global MCP registration, automatic approval,
arbitrary upstream RPC forwarding, or remote MCP hosting is provided.

## Upstream basis

The loop tools were verified with Codex 0.172.0. This version uses the native
call ID for the [started item](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/mcp_tool_call.rs#L1157-L1189)
and includes it in [MCP request metadata](https://github.com/openai/codex/blob/3d86e43b075adeba2193ec5c22ac92f55afd82e6/codex-rs/core/src/mcp_tool_call.rs#L1468-L1479).
The server uses standard
[MCP transport negotiation](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports)
and Codex's [bearer token configuration](https://learn.chatgpt.com/docs/extend/mcp).

Reproduction commands and validation boundaries are in the [verification record](managed-mcp-verification.md).
