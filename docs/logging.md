# Structured logging

Covro's server-side logging boundary accepts only allowlisted scalar metadata. Stable event names, UTC timestamps, severity, application version and a per-process `runId` identify each record. `AsyncLocalStorage` carries request and operation correlation; explicit child loggers bind long-lived jobs and Codex epochs.

Prompt text, generated titles, model output, request/response bodies, headers, environment variables and arbitrary exception messages/stacks are excluded at every level. Error records retain a safe error code/type, numeric RPC code and uncertainty flag. Adding metadata requires updating the shared allowlist and privacy tests.

The Pino destination uses pino-roll directly with asynchronous bounded SonicBoom writes. It does not need a worker-thread entrypoint or package resolution at runtime, including in the standalone bundled update worker. Each process writes its own `covro.<runId>.<date>.<number>.jsonl` files. Directories are private (`0700`), files are `0600` on POSIX systems.

Default policy: rotate daily or at 10 MiB, retain at most 14 days and a 200 MiB instance budget. Cleanup runs on startup, file open/rotation, every minute and shutdown. Live-process markers protect each writer's newest file; inactive runs and older rotated files share the retention budget. Active files and in-flight writes can temporarily exceed the budget. Cleanup only recognizes Covro filenames and never follows symlinks.

The buffer is bounded to 1 MiB. Overflow increments a dropped-record count and emits a rate-limited safe warning to stderr. File initialization/write errors degrade to rate-limited sanitized warning/error records on stderr without blocking user operations or building an unbounded queue. Normal shutdown waits up to three seconds for the stream to close. An uncaught exception writes and synchronously flushes a safe fatal record, then terminates with status 1; arbitrary exception text is not printed. SIGKILL, power loss and fatal native crashes cannot guarantee buffered records are saved.

`COVRO_LOG_LEVEL` accepts `debug`, `info` (default), `warn`, `error`, or `fatal`. Debug increases metadata detail without recording conversation content.

## Instrumented events

Gateway, database migrations, HTTP completion/errors, WebSocket subscription/backpressure, local MCP requests, Codex lifecycle/RPC failures, durable operation acceptance/dispatch/acknowledgement/reconciliation, turn boundaries, capacity retries, automatic titles/recaps, clones, backups and upgrade workers use the same logger interface. Successful polling/RPC details are debug-level; failures and significant state transitions are recorded by default. No streaming token events are logged.

`user_message.pending`, `submitted`, `failed`/`unknown` and `confirmed` events distinguish durable submission, the RPC receipt and matching native delivery evidence. They carry the original `operationId`, `threadId` and known `turnId`; recovery and terminal turns without confirmation record an `unknown` reason. Only actual database changes emit these events, so duplicate notifications and repeated snapshots do not repeat confirmation logs. `question.reply_claimed`, `reply_released`, `dismissed` and `action_saved` record local reply claims, definite-failure releases, tracking disposition and native action history. Question logs retain counts and safe action/thread/operation IDs, excluding question IDs encoded as JSON, question text, options and all answers, including non-secret answers.

An HTTP request receives a server-generated `X-Request-Id`. Its existing `operationId` follows the service and RPC calls. Automatic naming captures the submitting turn's context before asynchronous upstream notifications arrive; `jobId`, `sourceThreadId` and `temporaryThreadId` connect its internal inference to the source thread. Every naming attempt records one `thread_title.started` and one `thread_title.finished` outcome, with its last stage, duration and a bounded failure code. Naming retries and task semantics are unchanged.

Native interactive requests use `action.requested`, debug-level `action.replayed`, `action.reply_sent`/`reply_failed`, `action.resolved` and `action.expired`. Safe action/RPC/thread/turn/epoch IDs connect the lifecycle; `reason: human_command` identifies a one-time human checkpoint. A sent reply is separate from upstream resolution, which can also represent withdrawal. Command text, approval reasons, reusable rules and decision/answer payloads are excluded. Provider-independent history reads continue to use the existing metadata-only RPC events; provider lists, CWDs and returned history are not logged.

## Adding logs to code

Pass the existing `Logger` into server modules and bind a stable `component` with `logger.child()`. Reusable constructors may default to `nullLogger`, but their production callers must wire the process logger through. Process entrypoints own `createLogging`, crash monitoring and shutdown; business modules must not create their own writers or replace the logger with `console.*`. CLI result output stays on its existing output channel.

Check observability when changing external boundaries (HTTP, WebSocket, MCP and Codex RPC), durable state transitions, background jobs, retries, recovery, cancellation and failures. Add an event where existing events cannot explain the result. Reuse HTTP completion and operation/RPC events for routine request handling rather than logging the same failure at every layer. Pure transformations, rendering, repeated snapshot reads, streaming tokens and chunks need no per-item logs. Emit durable state events after a transaction commits and only when rows actually change.

Use stable lowercase dotted event names; never construct a name from input. Use `info` for significant lifecycle/state changes, `debug` for routine high-frequency diagnostics, `warn` for recoverable failures/degradation/uncertain results, `error` when functionality is unavailable, and `fatal` when the process cannot continue. Each background attempt should have a start and one final outcome with duration, including failure/cancellation. Carry correlation with `withLogContext`; capture `logContext()` into a child logger when accepting work that later resumes from a timer, queue or unrelated notification. Existing child bindings take precedence over ambient context, and explicit event fields take precedence over both.

For example, a module that receives a logger and a work function can record an asynchronous attempt as follows:

```ts
import type { Logger } from '../logging/logger.js';
import { logContext, withLogContext } from '../logging/context.js';
import { errorFields } from '../logging/fields.js';

export async function runJob(
  logger: Logger,
  threadId: string,
  jobId: string,
  work: () => Promise<void>,
) {
  const job = logger.child({ ...logContext(), component: 'example_job', threadId, jobId });
  const started = performance.now();
  job.info('example_job.started');
  try {
    await withLogContext({ threadId, jobId }, work);
    job.info('example_job.finished', {
      outcome: 'succeeded',
      durationMs: Math.round(performance.now() - started),
    });
  } catch (error) {
    job.warn('example_job.finished', {
      outcome: 'failed',
      durationMs: Math.round(performance.now() - started),
      ...errorFields(error),
    });
    throw error;
  }
}
```

The field allowlist in `src/logging/fields.ts` rejects unknown keys and non-scalar values; it does not make arbitrary text safe. Populate labels such as `reason`, `state` and `outcome` from controlled values. Never pass whole objects, exception text/stack/cause/details, prompts, titles, questions, answers, model/tool output, credentials, environment values, arbitrary paths or URLs. Apply the same rule at debug level. Review field sources before extending the allowlist and add privacy assertions alongside correlation, final-outcome and failure/uncertainty tests. Use `captureLogger()` from `tests/fixtures/logging.ts` to exercise the real sanitizing boundary; cover duplicate notifications and transaction rollback when relevant.

## Location and CLI

For `covro run`/background mode and the standalone server entry, logs live under `COVRO_HOME/instances/<config-key>/logs/` (`COVRO_HOME` defaults to `~/.covro`). The key is derived from the absolute configuration path, matching existing instance control. Logs remain outside `dataDir`, so a business-data restore does not roll back its diagnostic evidence. Upgrade workers and offline backup commands use the same instance directory with their own process/run identity.

```sh
covro logs                                       # last 200 matching records, readable text
covro logs --follow                              # continue across file rotation; Ctrl+C exits
covro logs --thread THREAD_ID --since 1h          # includes internal RPCs with sourceThreadId
covro logs --event thread_title.finished --json   # JSONL for scripts
covro logs --level warn --since 2026-11-05T00:00:00Z --lines 500
covro logs --config /absolute/path/config.json
```

`--level` is a minimum severity. `--event` matches an exact stable event name. `--since` accepts minutes/hours/days (`30m`, `1h`, `7d`) or an ISO timestamp with timezone. `--lines` accepts 1–10,000 and limits the initial history; follow mode then streams all new matching records. Readers skip malformed/oversized lines and retain byte offsets across incomplete UTF-8 records, replacement and rotation. CLI JSON output for `status`, `doctor`, update and backup commands remains separate from logging.

`covro status` and `covro doctor` include `logging` with the directory, process run ID, destination mode (`file` or degraded `stderr`), dropped-record count and optional safe failure code. A drop count or error code indicates missing evidence; an empty query is not proof that a task never ran. Older releases did not record these events, and installing this change does not reconstruct earlier failures.

The old `covro.log` is a bootstrap/fallback stderr file, not the structured log store. On daemon startup it is trimmed in place to its last 64 KiB once it exceeds 1 MiB, preserving service-manager append file descriptors. `covro logs` reads the structured store; inspect `covro.log` directly for failures before the logger initialized. Custom process-manager stdout/stderr capture still follows that manager's retention policy.

## Configuration

Settings are read from the service process environment at startup; restart after changes. Use `COVRO_LOG_LEVEL=debug covro run` for a foreground diagnostic run. For login services configure the environment in the original service manager; launching `covro logs --level debug` only filters existing records and does not enable debug recording.

| Variable                     | Default     | Meaning                                                         |
| ---------------------------- | ----------- | --------------------------------------------------------------- |
| `COVRO_LOG_LEVEL`            | `info`      | Minimum recorded severity                                       |
| `COVRO_LOG_MAX_FILE_BYTES`   | `10485760`  | Rotation size, 256 bytes–1 GiB                                  |
| `COVRO_LOG_MAX_TOTAL_BYTES`  | `209715200` | Instance retention budget, at least the file size, up to 10 GiB |
| `COVRO_LOG_MAX_AGE_DAYS`     | `14`        | Retention age, 1–365 days                                       |
| `COVRO_LOG_MAX_BUFFER_BYTES` | `1048576`   | Async buffer limit, 4 KiB–64 MiB                                |

Size checks occur after writes, and cleanup does not remove live writer files. Budget/age limits are retention targets, not a filesystem quota. File initialization failure switches to stderr; cleanup failure reports a degraded error code while keeping a healthy file writer active. Raw Codex stderr remains a bounded in-memory tail rather than being copied into these private structured records.

## Diagnose automatic titles

Filter by source thread ID and inspect `thread_title.started`, `thread_title.model_selected` and `thread_title.finished`. The finished record includes the last stage (`source_read`, `config_read`, `temporary_thread_start`, `turn_start`, `generation`, `output_validation`, `name_read`, `name_write`), outcome and a safe code such as `TITLE_TIMEOUT`, `TITLE_RPC_FAILED`, `INVALID_TITLE_OUTPUT` or `ISOLATION_MISMATCH`. RPC failure records with the same job ID retain their method, RPC code and uncertainty. A manual rename/another client's rename is distinguished from a generated title write. No title content or prompt is logged.
