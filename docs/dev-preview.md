# Development previews

[简体中文](dev-preview.zh-CN.md)

Open **Preview** in the conversation toolbar. Covro lists confirmed development services for that session, including their project, command, port and current status. Enable the preview proxy, then choose **Open preview** to open just that project in a new tab. Different projects use separate `/preview/<run capability>/` paths on the Covro address you already use.

Both **Enable development preview proxy** and **Allow full requests · High risk** default to off, including configurations created before this feature. Switch changes save immediately; controls are disabled while saving. Discovery continues while the proxy is off. Enabling the high risk option requires the main switch. Changing either setting withdraws existing preview links and connections; reopen the preview. Turning the proxy off also clears the high risk option. Settings apply to the Covro instance, not just the selected session.

## Discovery and lifetime

Covro remains a single npm package. Collectors use Node and system runtimes with source files; no custom executable/DLL, Node addon, compiler, downloaded runtime or platform-specific distribution package is added.

| Host        | Requirements                                                                                                                                                                                                           |
| ----------- | ---------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| Linux       | Readable procfs and the same network namespace as the service.                                                                                                                                                         |
| macOS 13+   | Built-in JavaScript for Automation (JXA), invoked through `/usr/bin/osascript`. It reads system process APIs without controlling applications or sending Apple Events.                                                 |
| Windows x64 | Native x64 Node and built-in Windows PowerShell 5.1 in FullLanguage mode. In-memory .NET bindings read Windows APIs; no C# compilation, saved assembly, elevation, debug privilege or execution-policy change is used. |

Windows services must be native x64 processes with readable metadata and an intact live ancestor chain, on local drive-letter directories. Directory junctions and 8.3 aliases are resolved for ownership checks without rewriting stored project paths. ARM64/WOW64 processes, UNC/mapped network directories and discovery across Windows/WSL are unsupported. A Covro instance running inside WSL uses the Linux collector for services inside that environment. Restricted sandbox accounts or organizational PowerShell controls may prevent inspection; Covro refuses preview instead of changing permissions. Windows Server 2022/2025 are the automated verification hosts; native Windows Codex sandbox and desktop Windows 10/11 end-to-end checks remain separately recorded in the [validation record](dev-preview-validation.md).

On every platform, missing/disabled system tools, unreadable metadata, missing markers, different network namespaces and unprovable ownership fail closed.

A localhost log line is not authorization. Covro combines a live command execution event in its current managed Codex epoch, the registered session workspace, actual descendant processes, exact `CODEX_THREAD_ID` / `CODEX_TOOL_CALL_ID` environment markers, kernel process birth identity, and a real listening socket. Codex execution IDs and tool process handles are not OS PIDs. Descending from a shared app-server alone does not establish which session owns a service. Project-level Shell and unrelated local listeners do not qualify.

Before sending HTTP bytes, Covro also checks the accepted connection's actual server-side owner and rechecks the registered process. Service exit, changed ownership, PID/port reuse, failed inspection and app-server/Covro restart withdraw the old link. Discovery polls once per second and verifies at request time. Previously seen ports are not restored after restart; a new live execution event is required. Start the development service from the session again when appropriate; Covro never silently restarts it.

Covro does not move a command outside its sandbox, change its permissions, extend its timeout, detach it, or assume responsibility for keeping it alive. The existing project Shell timeout remains ten minutes and that Shell is not attributed to a conversation. A long-running Codex execution is still managed by Codex. Closing a preview tab does not stop the service.

## Request policy and isolation

| Mode                      | Allowed application traffic                                                                       |
| ------------------------- | ------------------------------------------------------------------------------------------------- |
| Proxy off                 | None; confirmed services remain visible                                                           |
| Strict                    | GET/HEAD front-end resources, checked on every response; controlled Vite HMR only                 |
| Full requests · High risk | Registered service's business APIs, writes, arbitrary response types, SSE and business WebSockets |

Strict mode checks response MIME as well as browser request purpose. JSON/SSE, browser fetch/XHR, writes and ordinary WebSockets are blocked. An HTML homepage does not unlock a whole port. MIME checking occurs **after the GET reaches the service**; it cannot prove a resource endpoint is static, read-only or free of side effects.

Full requests keep authentication, target binding, process checks and browser sandbox. They do not create a forward proxy. Browser fetch/XHR is carried in a bounded, target-checked text envelope so an opaque-origin CORS preflight need not bypass an existing access gateway. Explicit application headers, including an application Authorization supplied by project code, are separate from automatic management authentication. Cookie sessions, native form submission, synchronous binary XHR and arbitrary cross-origin SDK communication are not compatible with this isolated mode.

Every preview response, including a directly opened resource, forces CSP `sandbox allow-scripts` **without `allow-same-origin`**. Preview scripts cannot use Covro localStorage, IndexedDB or document cookies. Frames, plugins, forms and popups are restricted; ServiceWorker/SharedWorker and APIs requiring an origin may not work. The manager's API still rejects `Origin: null`; null alone never grants access. A preview capability is bound to an entry Origin, authenticated subject and expiration (at most one hour). Treat its URL as private and reopen after expiry or switching Covro entry addresses.

Covro management cookies, management Authorization and Cloudflare Access assertions are not sent to the development service. Upstream Set-Cookie and security-state headers are discarded. External upstream redirects are not followed. Process ownership prevents accidental forwarding; it does **not** sandbox a malicious development server, which could itself proxy other services.

Text resources and request envelopes are limited to 16 MiB. Embedded fonts are limited to 8 MiB each and 12 MiB total per CSS resource. WebSocket messages/buffering are bounded. Range requests and upstream compression that ignores `Accept-Encoding: identity` are unsupported. Long connections are closed on policy or ownership revocation.

## Paths, routing and Vite HMR

The adapter changes responses in memory; it does not edit project files, change an already running Vite base, or restart the server. It parses HTML, CSS and JavaScript rather than replacing all matching strings.

Supported cases include HTML `src`/`href`/`srcset`, public root images/icons, CSS `url()` and imports, font embedding, module imports/exports, literal dynamic imports and `new URL()`, import maps, Vite CSS modules, common DOM URL setters and inserted HTML. Root URLs retain the exact run prefix; no global project-selection cookie or root-path fallback is used. Vite's injected `BASE_URL` and recognized HMR client are adapted to the same prefix. HMR token/path/protocol are controlled per preview. Standard updates, reloads and reconnects are supported; custom HMR business events are blocked in strict mode.

Client history and link URLs are prefixed; deep refreshes are forwarded to the same server, whose SPA fallback must support them. Routers that read `location.pathname` should already use Vite's `import.meta.env.BASE_URL` as their basename. A router hardcoded to `/` may fail to match the prefixed path: Covro cannot transparently virtualize Location. Arbitrary computed dynamic imports, hardcoded localhost origins, absolute external URLs, custom fetch/worker stacks and third-party SDKs are not universally adapted. Unknown Vite client shapes fail with an explicit adapter error; the current browser proof uses the repository's locked Vite 8.3.4. Review an unsupported app's base/router/HMR configuration and restart it yourself only if you choose to change it.

## Existing access addresses

No separate subdomain, certificate or project port mapping is required. Your existing entry must pass `/preview/*`, HTTP and WebSocket upgrades to Covro. TLS can terminate in front of Covro: the validated entry Origin determines HTTPS and wss, not untrusted forwarding headers.

Opaque-origin module and WebSocket requests still need the entry's authentication. The adapter requests credentials for resources and modules; font data is embedded because browser font requests can be anonymous. A cookie-based access gateway must permit the necessary cross-site credentials (typically Secure / SameSite=None), and browser third-party-cookie policy can still prevent access. Covro never weakens management Origin rules to compensate. Actual Cloudflare Access deployments need verification with their own policies; a signed-JWT fixture or dummy cookie experiment is not that verification.

See [the validation record](dev-preview-validation.md) for the direct-access result, native-vs-fixture distinction, and outstanding Tailscale/Cloudflare Access checks. Missing real-link checks are not recorded as passing.

References: [Vite base](https://vite.dev/config/shared-options#base), [public base path](https://vite.dev/guide/build#public-base-path), [server HMR](https://vite.dev/config/server-options#server-hmr), [CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox).
