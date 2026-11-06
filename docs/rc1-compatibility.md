# DSH rc.1 兼容与 API 清单

ACP 使用官方 DSH `0.2.2-rc.1`；Session／Query 需要同基线 capture fork，通过 pnpm overrides 注入。Cordis 为 4.1.0，Schemastery 为 3.19.0；构建工具链为 pnpm 11.28.5、TypeScript ^6.0.3。以下清单覆盖生产代码直接使用的 DSH API；测试另消费 agent-loop-testkit、JSONL、SQLite、llm-replay、session-snapshot 和 Loader／Include。

## 生产 API

| 所属包 | 使用的 API | 依赖语义 |
| --- | --- | --- |
| `dsh-session-query` | `captureSession(id, synchronousCallback, { projectionMode: 'none' })`；`SessionCaptureReader`；`SessionObservation.events` | F1 保留的 fork 签名。borrowed reader 是调用中的原始 live Session，回调不 await、不保留借用容器；独立复制节点、事件和派生消息。ACP 不调用 `pageSessions`、`pageEvents` 或 `readEvents`。 |
| `dsh-session` | `Session`、`SessionEvent`、`SessionId`、`SessionSeq`；`surface.nodes`；`seq`、`eventAt`；`deriveEventMessage`；`requestHeader`；`append`；`session/event`、`session/disposed` | 读取当前 Surface 与完整 Log。写入使用 `compaction/prune` + `user/message` replace；`sourceEventSeqs` 保留原调用、结果和来源范围。 |
| `dsh-session` 事件 | `turn/start`、`turn/end`、`step/start`、`step/end`、`assistant/message`、`tool/call`、`tool/result`、`user/message`、`system/message`、`developer/message`、`compaction/summary`、`compaction/end` | 保护当前 Step、最新任务及其 checkpoint；确认事务的实际替换，不把 body 成功当作最终成功。其余合并扩展事件按需跳过。 |
| `dsh-compaction` | `CompactionResult`、`CompactionId`、`toolPairingBalancedBefore`、`toolPairingBalancedAfter` | 使用上游平衡切点与事务结果，工具跨度先求闭包再检查保护／冲突。 |
| `dsh-compaction-basic` | `BasicCompactionEngine`、`BasicCompactionConfig`、`ResolvedConfig`、`Config`；`compactRegion`、受保护 `summarize` hook、`config` | 仅替换模型主动调用的摘要来源；自动压力、模型切换压力、pruner、overflow 与 idle maintenance 仍继承上游实现。 |
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
- 0.2.2 将执行拆到 `dsh-tool-executor-native`／`dsh-tool-executor-ptc` 插件；`tools.mode` 已删除。两个 executor 都使用标准工具 pipeline，root run_code 仍触发 guard、`tools/execute`、`tools/post-execute`、`tools/result`，token／parent／rootCallId 关联不变。PTC 指定的程序必须是 TypeScript function-body 格式，完整 code 恰为 `return await tools.context_compress(<JSON literal>);`（允许首尾空白）。Python／REPL 语法不在本插件的 PTC 支持范围内。

## PTC 最终结算

规范压缩程序只含一个 JSON 字面量调用；root run_code 必须是独立的真实 assistant 调用，其唯一直属子调用的参数必须与 JSON 深等。普通脚本提及 `context_compress` 字样不受限制；非规范脚本实际调用该工具时，调用层 guard 因其缺少规范 root 登记而拒绝压缩，不阻止脚本中此前的普通调用。压缩仍发生在当前 Step 内，当前 Step 全部受保护。无需跨 Step 排队，也不会在取消后另用独立信号启动新压缩。

子调用的最终提交事实写入 root 结果。上游最后阶段取消或策略异常可能覆盖该正文；最终 `tools/result` observer 在这种情况下追加 source 为 `acp-maintenance` 的有界持久状态 notice，不额外启动模型步骤。原生与 PTC 均保留已提交 region，取消或未知故障停止余项。

仅当全部 region 成功且 root 最终成功时，PTC root pair 才可在下一 Step 替换为短状态；partial、失败、取消和宿主覆盖不隐藏。状态保留输入范围、来源 Log seq 和错误，不重复 summary；记录放不下时保留原 pair。原始程序参数与结果始终可从 Log 回读。

## 未发布 fork 的开发安装

Session／Query peers 与 devDependencies 使用官方精确版本 `0.2.2-rc.1`，不把 fork 后缀写进 peer 范围。匹配的 `0.2.2-rc.1-fork1` 资产未发布时不填写 URL；旧 fork 覆盖已删除，完整构建与验收标记为“待 fork 包”。开发时可用未提交的本地 pnpm overrides 指向实际 tarball，并由 pnpm 生成锁文件；不得把本机路径提交。发布前填写 `.github/release-dependencies.json` 的真实来源。隔离成品验证需要显式传入 ACP、Session、Query、SQLite 四个实际资产，见[交付指南](delivery.md)。

`pnpm test:executors` 直接针对 npm 的 0.2.2 executor 验证原生准入、最终错误、PTC 根结果和策略覆盖，不依赖 capture。完整源码验收继续用 `DSH_SOURCE_ROOT=/absolute/path/to/capture-capable-fork pnpm check`，仅运行本插件选中的测试。`BasicCompactionEngine.summarize` 与压缩事务接口未变；主动摘要之外继续调用 `super.summarize`，模型切换检查由上游 Basic 注册。
