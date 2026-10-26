# Model capacity and retries

Codex owns its native request and stream retries. Covro displays reported retry attempts and the original error cause. Some request retries and the first WebSocket retry are silent upstream. The protocol does not report a native retry deadline, so Covro does not invent a native countdown.

If a gateway-started turn fails with `serverOverloaded` and Codex has not reported native retries, Covro can continue the same conversation after 5, 10, and 20 seconds, up to three additional attempts. A legacy error is recognized only when an actual failure has the exact capacity error message and no conflicting structured error classification. Conversation text never triggers retries.

Automatic continuation is limited to turns with no model output, reasoning, tool activity, approvals, or other progress. It uses empty input and a snapshot of the original model, reasoning effort, service tier, and explicit permission choices. The existing Codex conversation retains the original prompt, images, and tool history; Covro does not submit them again or roll back tool operations. Each continuation is a new native turn and uses the normal durable operation and execution reservation. An uncertain dispatch is never automatically replayed.

The countdown runs on the server and survives browser refreshes or disconnection. Cancel retries to stop a pending timer; if a continuation is already running, Covro interrupts that turn when its identity is known. A new task supersedes a pending retry. Archiving, runtime changes, and gateway shutdown stop automatic recovery. Gateway restarts do not resume timers.

After cancellation or exhaustion, choose a model in the composer and use **Retry with selected model** to continue manually. Turns with partial output or tool work require this explicit action. Review the existing results before continuing: this is conversation continuation, not an exactly-once guarantee for model-directed tools. Other errors and native retry exhaustion do not receive an additional automatic retry budget.

## 容量不足与重试

Codex 负责原生请求与流重试。Covro 展示上游报告的次数和原始原因；部分请求重试和首次 WebSocket 重试不会发送通知。原生协议没有下次尝试时间，因此原生阶段不显示推测的倒计时。

由本服务发起的轮次在尚未产生模型输出、思考、工具操作、审批等进展时，若确认为 `serverOverloaded`，且未观察到 Codex 原生重试，Covro 会按 5、10、20 秒退避，最多补偿重试 3 次。旧版本只在真实失败字段完全匹配容量错误文本、且没有冲突的结构化分类时使用文本兼容；普通回复、引用和代码块不会触发。

重试使用原会话的空输入续跑，并保留原模型、推理强度、服务等级和显式权限选择。原提示词、图片及历史工具结果仍在 Codex 上下文中，不会重新提交，也不会回滚工具操作。续跑会建立新的原生轮次，沿用正常的持久操作与执行占位；派发结果不确定时绝不自动重放。

服务端倒计时可跨页面刷新及断线继续。取消会停止待执行的重试；续跑已经启动时，在能够确认轮次身份后中断它。新任务会替代待执行的重试；归档、运行时变化和服务关闭也会停止恢复。服务重启后不会恢复定时器。

取消或达到上限后，可以在输入框工具栏选择模型，再点“使用所选模型重试”。已有输出或工具操作时也必须手动确认继续，请先检查已有结果；会话续跑不能保证模型发起的工具操作恰好执行一次。其他错误或原生重试耗尽后，不会再叠加自动重试预算。
