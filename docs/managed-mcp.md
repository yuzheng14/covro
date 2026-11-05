# Covro tools for managed Codex sessions

Covro exposes two MCP tools to the `codex app-server` process it starts. They cover
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

## Retry and failure behavior

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
entry. Tool names remain `list_projects` and `create_session`. Neither global nor
project Codex/MCP configuration is written. Independently started CLI, IDE and
app-server processes do not automatically obtain this entry, including when they
resume a conversation created in Covro.

This local interface has no separate token or account authentication. Other local
programs that know its address can connect manually. Host and Origin validation,
body limits and the existing business checks still apply; metadata is context,
not proof of process identity. Existing browser/API authentication, including
Cloudflare Access, is unchanged.

The endpoint closes with the gateway. The process-only entry is reapplied when
the managed app-server restarts. Internal title and recap threads retain their
existing MCP/tool isolation. No user-global MCP registration, automatic approval,
arbitrary upstream RPC forwarding, or remote MCP hosting is provided.

## Upstream basis

The integration targets Covro's verified Codex 0.166.0
([`6ff1e1ca`](https://github.com/openai/codex/tree/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856)).
The MCP client defaults to the 2025-06-18 lifecycle; the server uses standard
version negotiation rather than requiring experimental MCP features. See
[transport configuration](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/config/src/mcp_types.rs#L652),
[call metadata](https://github.com/openai/codex/blob/6ff1e1ca3b30fc8b914720681fcf5fe62e95f856/codex-rs/core/src/mcp_tool_call.rs#L1331),
and [the transport specification](https://modelcontextprotocol.io/specification/2025-06-18/basic/transports).

Reproduction commands and validation boundaries are in the [verification record](managed-mcp-verification.md).
