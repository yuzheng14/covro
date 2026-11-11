# 会话开发预览

[English](dev-preview.md)

在会话工具栏打开**预览**，查看已确认归属的项目、启动命令、端口和状态。开启代理后点**打开预览**，新标签页只展示项目。不同项目使用现有 Covro 地址下各自的 `/preview/<运行能力>/`，不共享资源选择 Cookie。

**启用开发预览代理**和**允许完整请求 · 高危**均默认关闭，包括旧配置升级。关闭代理仍可发现服务；高危选项须先开启总开关。任一设置变化都会撤销已有链接和连接，请重新打开预览；关闭总开关同时清除高危选项。设置作用于整个 Covro 实例。

## 归属与生命周期

支持 Linux procfs 和 macOS 13+；安装包内含只读的 arm64/x86_64 通用系统辅助程序，不使用 Python、提权或运行时编译器。其他平台、元数据不可读、标记缺失、网络 namespace 不一致或归属无法证明时拒绝开放。辅助程序被修改或与校验清单不符也会拒绝。

localhost 日志不是授权依据。发现需要当前受管 Codex epoch 的实时执行事件、会话工作目录、实际子进程链、精确的 `CODEX_THREAD_ID` / `CODEX_TOOL_CALL_ID` 环境标记、内核进程 birth identity 及真实监听 socket。Codex 执行 ID 和工具进程句柄都不等于 OS PID。多个会话共享 app-server，仅靠子进程链不能确定当前会话归属；项目级 Shell 和无关本机服务不会因此进入当前会话。

发送 HTTP 字节前还会核对已建立连接的服务端 socket 拥有者，并重新核对登记进程。进程退出、归属变化、PID/端口复用、检查失败、app-server 或 Covro 重启均撤销旧入口。每秒检查并逐请求复核；重启后不恢复旧端口，必须收到新的实时执行事件。按需在会话中重新启动服务，Covro 不会静默重启。

预览不改变命令的沙箱、权限、超时，不脱离 Codex 托管，不接管保活。项目 Shell 的十分钟超时保持原样，也不会被归到会话。Codex 长时间执行仍由 Codex 管理。关闭标签页不停止开发服务。

## 请求策略与隔离

| 模式            | 应用流量                                                      |
| --------------- | ------------------------------------------------------------- |
| 代理关闭        | 不开放代理，仍显示已确认服务                                  |
| 严格模式        | 仅 GET/HEAD 前端资源，每个响应检查；仅受控 Vite HMR           |
| 完整请求 · 高危 | 已登记服务的业务 API、写入、任意响应类型、SSE、业务 WebSocket |

严格模式结合浏览器资源目的与每次响应 MIME，拒绝 JSON/SSE、fetch/XHR、写请求和普通 WebSocket。首页返回 HTML 不会放开整个端口。MIME 检查在 GET 已到达上游后发生，**不能证明接口静态、只读或无副作用**。

高危模式保留身份、目标绑定、进程核验和 sandbox，不是通用正向代理。fetch/XHR 通过限长、目标受控的文本信封发送，避免 opaque-origin CORS 预检要求现有入口绕过认证。项目代码显式提供的应用请求头（包括应用自己的 Authorization）与浏览器自动附带的管理认证分开。Cookie 登录态、原生表单提交、同步二进制 XHR、任意跨域 SDK 不兼容此隔离模式。

所有预览响应，包括直接打开资源，强制 CSP `sandbox allow-scripts`，**不授予 allow-same-origin**。项目脚本不能读取 Covro localStorage、IndexedDB 或 document.cookie。frame、插件、表单、弹窗受限；ServiceWorker/SharedWorker 及需要稳定 origin 的 API 可能不可用。管理 API 继续拒绝 `Origin: null`，null 本身从来不是身份。每次打开生成的能力绑定入口 Origin、认证主体和期限，最长一小时；请将 URL 视为私密链接，过期或切换 Covro 入口后重新打开。

不会向开发服务透传管理 Cookie、管理 Authorization 或 Cloudflare Access assertion；上游 Set-Cookie 及安全状态头被丢弃，不跟随外部上游重定向。进程归属用于防止误代理，不能隔离恶意开发服务器自身转发到其他服务。

文本资源与请求信封最大 16 MiB；字体每个 8 MiB、每份 CSS 合计 12 MiB；WebSocket 消息及缓冲有限额。不支持 Range 请求或忽略 `Accept-Encoding: identity` 的上游压缩。策略/归属撤回会关闭长连接。

## 路径、路由与 HMR

适配只修改内存中的响应，不写项目文件，不改变运行中 Vite 的 base，不重启服务。HTML、CSS、JS 使用语法解析器。

支持 HTML `src`/`href`/`srcset`、public 根路径图片图标、CSS `url()` 与导入、字体内嵌、模块导入导出、字面量动态导入和 `new URL()`、import map、Vite CSS 模块、常见 DOM URL 属性及插入 HTML。所有根路径保留对应运行前缀；不通过 Covro 根路径兜底转发或 Cookie 选择最近项目。Vite 注入的 BASE_URL 和可识别的 HMR client 适配到同一前缀；每个运行单独控制 HMR token、路径与协议，支持标准更新、重载和重连，严格模式拒绝自定义业务 HMR 事件。

链接和 history URL 会加前缀，深链刷新发往原服务，服务自身须支持 SPA fallback。读取 `location.pathname` 的路由器应以 Vite `import.meta.env.BASE_URL` 为 basename；写死 `/` 的路由器可能不能匹配带前缀路径，Covro 无法透明虚拟化 Location。任意计算的动态 import、写死 localhost 的 origin、绝对外部 URL、自建请求/worker 和第三方 SDK 不能保证透明适配。未知 Vite client 结构明确报适配错误；当前真实浏览器验证为仓库锁定的 Vite 8.3.4。请检查不兼容应用的 base/路由/HMR 配置，只有你选择修改时才自行重启。

## 现有访问入口

无需独立子域名、证书或逐项目端口映射；入口须将 `/preview/*`、HTTP 和 WebSocket upgrade 送到 Covro。支持 TLS 在前置终止：HTTPS/wss 使用已验证的入口 Origin，不信任转发头来决定授权。

opaque-origin 模块及 WebSocket 仍需现有入口身份。适配器为资源和模块请求凭据，字体因浏览器可能匿名请求而内嵌。Cookie 型入口必须允许必要跨站凭据（通常为 Secure / SameSite=None），浏览器第三方 Cookie 策略仍可能阻断。不会为此放宽管理 Origin。实际 Cloudflare Access 策略必须单独验证；签名 JWT fixture、虚拟 Cookie 实验不等于真实 Access 验证。

[验证记录](dev-preview-validation.md) 区分直接访问、原生 Codex、执行事件 fixture、尚未完成的 Tailscale/Cloudflare Access 链路，不将缺失检查记为通过。

参考：[Vite base](https://vite.dev/config/shared-options#base)、[公共基础路径](https://vite.dev/guide/build#public-base-path)、[HMR](https://vite.dev/config/server-options#server-hmr)、[CSP sandbox](https://developer.mozilla.org/en-US/docs/Web/HTTP/Reference/Headers/Content-Security-Policy/sandbox)。
