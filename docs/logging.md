# Structured logging

Covro's server-side logging boundary accepts only allowlisted scalar metadata. Stable event names, UTC timestamps, severity, application version and a per-process `runId` identify each record. `AsyncLocalStorage` carries request and operation correlation; explicit child loggers bind long-lived jobs and Codex epochs.

Prompt text, generated titles, model output, request/response bodies, headers, environment variables and arbitrary exception messages/stacks are excluded at every level. Error records retain a safe error code/type, numeric RPC code and uncertainty flag. Adding metadata requires updating the shared allowlist and privacy tests.

The Pino destination uses pino-roll directly with asynchronous bounded SonicBoom writes. It does not need a worker-thread entrypoint or package resolution at runtime, including in the standalone bundled update worker. Each process writes its own `covro.<runId>.<date>.<number>.jsonl` files. Directories are private (`0700`), files are `0600` on POSIX systems.

Default policy: rotate daily or at 10 MiB, retain at most 14 days and a 200 MiB instance budget. Cleanup runs on startup, file open/rotation, every minute and shutdown. Live-process markers protect each writer's newest file; inactive runs and older rotated files share the retention budget. Active files and in-flight writes can temporarily exceed the budget. Cleanup only recognizes Covro filenames and never follows symlinks.

The buffer is bounded to 1 MiB. Overflow increments a dropped-record count and emits a rate-limited safe warning to stderr. File initialization/write errors degrade to rate-limited sanitized warning/error records on stderr without blocking user operations or building an unbounded queue. Normal shutdown waits up to three seconds for the stream to close; forced process termination cannot guarantee buffered records are saved.

`COVRO_LOG_LEVEL` accepts `debug`, `info` (default), `warn`, `error`, or `fatal`. Debug increases metadata detail without recording conversation content.
