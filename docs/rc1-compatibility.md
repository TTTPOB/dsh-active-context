# DSH rc.1 兼容与 API 清单

ACP 0.5 使用官方 DSH `0.2.1-rc.1` 与配套 Session／Query `0.2.1-rc.1-fork1`。Cordis 为 4.0.5，Schemastery 为 3.18.5；构建工具链为 pnpm 11.28.5、TypeScript ^6.0.3。以下清单覆盖生产代码直接使用的 DSH API；测试另消费 agent-loop-testkit、JSONL、SQLite、llm-replay、session-snapshot 和 Loader／Include。

## 生产 API

| 所属包 | 使用的 API | 依赖语义 |
| --- | --- | --- |
| `dsh-session-query` | `captureSession(id, synchronousCallback, { projectionMode: 'none' })`；`SessionCaptureReader`；`SessionObservation.events` | F1 保留的 fork 签名。borrowed reader 是调用中的原始 live Session，回调不 await、不保留借用容器；独立复制节点、事件和派生消息。ACP 不调用 `pageSessions`、`pageEvents` 或 `readEvents`。 |
| `dsh-session` | `Session`、`SessionEvent`、`SessionId`、`SessionSeq`；`surface.nodes`；`seq`、`eventAt`；`deriveEventMessage`；`requestHeader`；`append`；`session/event`、`session/disposed` | 读取当前 Surface 与完整 Log。写入使用 `compaction/prune` + `user/message` replace；`sourceEventSeqs` 保留原调用、结果和来源范围。 |
| `dsh-session` 事件 | `turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/message`、`tool/call`、`tool/result`、`user/message`、`system/message`、`developer/message`、`compaction/summary`、`compaction/end` | 保护当前 Step、最新任务及其 checkpoint；确认事务的实际替换，不把 body 成功当作最终成功。其余合并扩展事件按需跳过。 |
| `dsh-compaction` | `CompactionResult`、`CompactionId`、`toolPairingBalancedBefore`、`toolPairingBalancedAfter` | 使用上游平衡切点与事务结果，工具跨度先求闭包再检查保护／冲突。 |
| `dsh-compaction-basic` | `BasicCompactionEngine`、`BasicCompactionConfig`、`ResolvedConfig`、`Config`；`compactRegion`、受保护 `summarize` hook、`config` | 仅替换模型主动调用的摘要来源；自动压力、pruner、overflow 与 idle maintenance 仍继承上游实现。 |
| `dsh-agent` | `Agent.id`、`Agent.session`；`agent/pre-step`、`PreStepDecision` | 外层 awaited wrapper 在原生压力前清理已确认工具对，在原生压力后重测提醒；始终调用 `next()`。 |
| `dsh-tools` | `defineTool`；`tools.register`、`tools.guard`；`ToolExecution`、`ToolRunContext`、`ToolExecutionResult`、`ToolExecutionFailure`；`finalizeContent`；`tools/execute`、`tools/post-execute`、`tools/result` | root／child 通过不可变 token、parent 和 rootCallId 关联；最终错误与取消保留。PTC 子调用自身不是 Surface 的 tool/result。 |
| `dsh-system-prompt` | `systemPrompt.section({name, order, text})` | 模型指令作为持久可重建的 system prompt section 贡献；注册随插件卸载撤销。 |
| `dsh-token-meter` | `measure(session)`、`estimateMessage(message)`；`TokenMeasurement`、node `tokens`／`heuristicTokens` | 路由 token 用于缩水与压力，固定 heuristic 用于上游 shadow 计量；所有预算包含既有消息包装规则。 |
| `dsh-llm` | `createUserMessage`、`boundContextSummary`、`HarnessError`；`Message`、`UserMessage`、`ContentBlock`、`ToolCallId`、`ToolSchema`、`TokenUsage`；`llm.resolveModelInfo` | typed source 标识 ACP pressure／maintenance notices；读取已路由模型窗口与输出保留，不额外生成主动摘要。 |

## rc.1 的相关行为

- `plugin:` records 属于插件自有、可忽略的 Log 数据，不进入模型 Surface。ACP 通过 `deriveEventMessage` 获取实际文本，从不扫描任意 payload；它们保留在 capture Log 内，不成为任务、端点或独立压缩目标。
- 上游 required runtime context 在关闭可选动态 context 时仍被组装。`runtime-context` snapshot 不是 `form:instructions`；若旧 snapshot 被压缩，上游 `RuntimeContextProjection` 根据 replacement 来源使 retained snapshot 失效，在下一请求重新提交当前 operational context。ACP 不抑制或重写 systemPrompt 组装。对应回归验证 required context 在替换后重新出现。
- system prompt 可能以 in-history replacement 更新；ACP 保护所有存活 system／developer 与 `form:instructions` 节点，而不是只保护 seq 0。
- `dsh-invariants` 运行时已删除，源码、交付依赖与锁定基线均不再引用它。
- rc.1 仅有 `native`／`ptc` 呈现模式。PTC 指定的程序必须是 TypeScript function-body 格式，完整 code 恰为 `return await tools.context_compress(<JSON literal>);`（允许首尾空白）。Python／REPL 语法不在本插件的 PTC 支持范围内。

## PTC 最终结算

规范程序只含一个 JSON 字面量调用，guard 拒绝变量、注释和额外语句；root run_code 必须是独立的真实 assistant 调用，其唯一直属子调用的参数必须与 JSON 深等。压缩仍发生在当前 Step 内，当前 Step 全部受保护。无需跨 Step 排队，也不会在取消后另用独立信号启动新压缩。

子调用的最终提交事实写入 root 结果。上游最后阶段取消或策略异常可能覆盖该正文；最终 `tools/result` observer 在这种情况下追加 source 为 `acp-maintenance` 的有界持久状态 notice，不额外启动模型步骤。原生与 PTC 均保留已提交 region，取消或未知故障停止余项。

仅当全部 region 成功且 root 最终成功时，PTC root pair 才可在下一 Step 替换为短状态；partial、失败、取消和宿主覆盖不隐藏。状态保留输入范围、来源 Log seq 和错误，不重复 summary；记录放不下时保留原 pair。原始程序参数与结果始终可从 Log 回读。

## 未发布 fork 的开发安装

Session／Query peers 与 devDependencies 使用精确版本，不填写尚未发布的 URL。验证使用被 Git 忽略的本地 `pnpm-workspace.yaml` overrides 和 `.scratch/` lockfile，指向实际 F1 tarball；这些本机路径不进入发布 manifest 或提交。旧 rc.2 lockfile 已移除；正式 fork 资产发布并固定来源后，由 pnpm 重新生成发布 lockfile。隔离成品验证需要显式传入 ACP、Session、Query、SQLite 四个实际资产，见[交付指南](delivery.md)。
