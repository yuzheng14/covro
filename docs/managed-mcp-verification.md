# Managed MCP verification

Date: 2026-11-05 (Asia/Shanghai). Scope: #295; Codex 0.166.0; MCP TypeScript SDK 1.32.2.

## Real binary, local model

Run the existing installed binary with a fresh home, two temporary projects and a
local HTTP Responses stub:

```sh
node --import tsx scripts/verify-managed-mcp.ts --binary /absolute/path/to/codex --output /tmp/managed-mcp-results.json
```

The probe exercises native Code Mode and MCP rather than substituting an
app-server fixture. It uses no account or remote inference, leaves user
configuration unchanged, and removes its temporary home and database when done.
The result is recorded in [managed-mcp-results.json](managed-mcp-results.json).

Verified:

- `list_projects` and `create_session` are discovered by native Codex and called
  through the injected MCP entry.
- The native write approval remains active. The probe responds only to the known
  temporary Covro MCP approval: decline creates no session; a later accept permits
  creation. It does not approve command or filesystem permission requests.
- A parent waiting for MCP can create and submit the first prompt in the selected
  project through the same app-server PID.
- Covro can continue the new conversation without a writer conflict.
- After managed app-server restart, resumed history obtains the injected entry.
- An independent app-server using the same isolated `CODEX_HOME` and resumed
  history does not obtain the Covro tools.
- Gateway shutdown closes the local MCP endpoint.
- The home TOML, including an existing unrelated `covro` MCP definition, remains
  byte-for-byte unchanged.

`--keep` runs the same checks and then leaves an isolated gateway running with an
additional session created through the SDK client. Its printed URL and IDs are
for browser verification; Ctrl-C stops it and removes the temporary files.

## Automated and browser checks

The session orchestration, protocol-neutral tools and standard SDK client tests
cover required prompts, canonical project selection, project availability changes,
concurrent duplicate calls, key conflicts, partial success, lost receipts,
restart recovery, compatibility/maintenance guards, MCP schemas and HTTP
boundaries. No schema migration is required.

The full unit/integration run passed 1500 tests with one existing skip. Typecheck,
ESLint, Prettier, production build, isolated production artifact verification,
npm package verification and the database contract check passed.
The 23 related Playwright cases for empty sessions, parallel execution, writer
occupancy and MCP session approvals passed. The fixture-backed upgrade/rollback
verification also passed all 16 scenarios.

The production frontend was opened against the isolated gateway in Browser Use.
The MCP-created session was selected through its returned URL, appeared under
Target project, displayed its exact initial prompt and completed response, and
accepted a second message from the UI. The model replies in screenshots are
explicit local stub output, not real model inference.
