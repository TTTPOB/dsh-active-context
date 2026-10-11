# ADR 0002：提前压力提醒与原生兜底共存

- 状态：Proposed（提议）
- 实施情况：未实现；路由阈值与预算待校准。

## 背景

主动压缩需要模型在达到自动压缩阈值前，有机会查看地图、回读历史并准备摘要。提醒也占上下文；持续重复催促会增加成本，尤其是在压缩失败或未降低压力时。

ACP 复用[通用地图](../../../dsh-session-tools/docs/adr/0004-context-map-and-metering.md)。[提交与清理 ADR](0001-active-compaction-submission.md)负责压缩执行和成功工具对清理；本文负责提醒时机、内容、预算与去重。

## 决策提案

### 提醒何时出现

首版在原生自动压缩线之前提醒，可附简短地图。原生 pruner、自动摘要和 overflow 处理保持原有执行规则。

每次准备模型请求时，按以下顺序处理：

1. 清理上一 Step 已成功结算的压缩工具对。
2. 执行原生压力检查：达到阈值时裁剪工具结果，重测，必要时自动摘要。
3. ACP 重测当前上下文；满足提醒条件时，把提醒加入这次请求。

只对本来会发出的请求加入提醒。拒绝、取消和原生会跳过的空步骤保持原行为，维护消息不能额外唤起付费请求。

### 提醒内容

提醒以 user-role 维护消息落档，来源为自有 `source.kind: acp-pressure`、`form: notice`，并提供有界 `source.summary`。正文标明“宿主上下文维护提醒”，包含压力估计及计量依据；有合适目标时附少量旧区间、来源标签、回读入口和 locator。

粗地图调用共享地图库生成，ACP 在提醒中添加保护与可压建议。模型需要更多内容时再查询详细地图或回读历史。提交时的目标检查遵循提交 ADR。

没有可压目标时，只说明压力状态。独立压缩调用规则放在 ACP 初始指引和工具描述中，提醒保持简短。

### 每段持续高压只提醒一次

从达到提醒线到降至复位线以下，视为一段持续高压期，可跨多个 Turn，也可跨重启。每段最多提交一条提醒。

| 情况 | 行为 |
|---|---|
| 达到提醒线，当前高压期尚未提醒 | 在本次正常请求中加入提醒 |
| 提醒消息实际落档 | 记为已提醒 |
| 候选提醒被拒或落档前取消 | 保留提醒机会 |
| 压缩成功但仍高压，或压缩失败/no-op | 不重复催促，原生压力处理继续 |
| 计量降至复位线以下 | 恢复提醒资格 |
| 新 Turn、新任务输入或切换路由 | 延续当前提醒状态；新路由使用自己的阈值 |
| 重启、重新加载或会话恢复（reload/resume/HMR） | 当前低于复位线则恢复资格；否则读取历史，有 ACP 提醒则延续已提醒状态，无提醒则允许提醒 |

压缩后的短确认和重启都不重置提醒状态。实际计量降至复位线以下即恢复资格，再次达到提醒线属于新一段高压，应再次提醒。

恢复时当前已低于复位线，直接按本次计量复位。当前未低于复位线时，使用历史提醒恢复去重状态。

## 阈值与预算

### 路由阈值

每个启用路由配置绝对提醒线 S（`nudgeAtTokens`）和较低的复位线 R（`resetBelowTokens`）。使用现有 token-meter 的 `measurement.totalTokens` 作为 T，并按部署配置核对 `R < S < H`。

H 是 Basic 的原生自动压缩线：

```text
H = floor(min(C × thresholdRatio, C − O − headroomTokens))
```

C 为路由上下文容量，O 为工作请求 maxTokens 或 adapter 默认输出预留，两者均未声明时 O 为 0。T 使用现有 baseline/delta，标明 API usage 或 estimated。

读取最新已落档路由和 Basic 配置，必要时用 `llm.resolveModelInfo` 查询模型容量。路由缺配置或容量未知时给出诊断，保留原生压力处理；加载时可确定的配置错误直接拒绝，动态缺项在首次可判断时报告。

### 提醒预算与校准

提前量应容纳整条提醒和一次普通地图/回读准备。整条 `reminderMaxTokens` 覆盖正文、消息包装、粗地图和指引，另设 UTF-8 bytes 上限。超预算先缩短预览，再减少区间，最终保留短提醒；token 限额沿用启发式计量。

骨架完成后，选择主用路由，用本机会话粗测提醒、地图、回读和摘要开销，统一确定 S/R、提醒长度及批次摘要预算。以留出实际准备空间、控制日常成本为目标，后续按使用结果调整。

## 实现方式

使用 awaited pre-step 的外层 wrapper：在 `next()` 前清理工具对，`await next()` 执行原生压力处理，再重测并向获准 decision 的 messages 加入提醒，保留其他元数据。wrapper 在 Basic hook 外层注册；空步骤抑制沿用现有 model-switch notice 的条件。此阶段位于 system/context assemble 之后。

候选提醒拥有自己的 Message.id，只有同步 session/event 观察到对应 user/message 落档，才标为已提醒。请求内重试复用 Loop 的 firstAttempt 落档行为。

内存保存 session-local 提醒资格、已提醒状态和候选 id。新会话初始化为可提醒。恢复时先执行原生压力处理并测量当前 T：低于 R 则恢复资格，否则通过 Query 的原始 Log observation 从尾部查找 ACP 提醒，找到则记为已提醒，未找到则允许提醒。提醒正文被 Surface 压缩后仍从原始 Log 读取。恢复只执行一次，正常步骤使用内存状态，并在实时测得 T < R 时复位。

切换路由延续状态，实时计量使用最新已落档路由的 S/R。复位只更新内存，不写自定义事件，也不修改核心追加 API。

## 理由与替代方案

- **每个 Step 或 Turn 都提醒。** 长 Turn、失败和 no-op 会重复产生开销；按持续高压期去重。
- **跨原生阈值固定两步宽限。** 可能同时跳过 pruner，Basic 也没有公开 prune-only 开关；首版保留原生调度。
- **为压力骤增增加特殊处理。** 当前按较少遇到的场景暂不考虑，不增加额外抢先提醒或宽限机制，仍由原生压缩和 overflow 兜底。这是首版范围取舍，不是实测频率结论。
- **用 UI 占用率触发。** 它与完整 token 计量的依据不同；采用现有 measurement.totalTokens 和路由阈值。
- **动态修改 system prompt 或通过 agent.inject 提醒。** 前者改变指令来源，后者在此时通常进入下一步 inbox；使用本次 decision 中正常落档的维护消息。
- **只提醒、不附定位。** 内容更短，但模型需要额外寻找旧区间；粗地图可配置，由整条预算控制。
- **重启后直接重新提醒。** 会在同一高压期重复催促；结合当前计量与历史提醒恢复状态。
- **持久复位事件或完整历史压力重建。** 用于区分“已提醒 → 降压 → 再次升高 → 第二次提醒落档前恰好重启”。本方案明确不考虑这个重启窗口，不为此新增日志事件、核心 API 或恢复队列；该情况下可能延续旧的已提醒状态，直到再次测得 T < R。
- **新增原生压力策略查询接口。** Basic 配置及模型容量已经可读，完整 policy resolver 未从包根导出；首版按部署配置核对 H，保持现有公开 API。

## 后果与风险

若一个步骤产生的上下文增量跨过提醒线与原生压缩线，原生自动压缩会先执行；输出有预算也可能跨过两条线的间隔，无需假定上下文可以无界增长。阈值校准结合单步输出预算，尽量留足提前量。切换到较小上下文容量的模型，也可能直接触发原生兜底。

pre-step 使用最近已落档路由，pending 输入及后续 system 更新可能尚未计入；提醒提供准备机会，不替代请求容量检查。

提醒、地图、回读和摘要会增加请求成本，历史前缀替换可能影响缓存命中。效果需结合压缩后的任务完成情况、实际 usage 和延迟评估。

## 验收要点

1. 低于 S 不提醒；同一持续高压期只提交一条，跨 Turn 和重启仍去重；T < R 后恢复资格。失败/no-op 和换路由不反复催促。
2. 落档前拒绝或取消保留机会，请求重试不重复。正常运行中降压再升高允许新提醒；跨 reload/resume/HMR 验证当前低压直接复位、历史已有提醒时去重、无提醒时允许；提醒正文被压缩后仍可从 Log 读取，正常步骤不扫描历史。
3. 本次请求可见且可回放，来源、form 和 summary 正确，其他 decision 元数据保留。
4. 真实 Loader 中的清理→原生压力处理→ACP 重测→提醒顺序正确；空首步及被跳过的 continuation 不产生额外请求。
5. 完整预算覆盖消息包装和地图，缩减后仍有短提醒；容量未知有诊断，无可压目标时仅提示状态。
6. 忽略提醒后仍按 H 执行 prune→重测→摘要；overflow 和依赖实际 replacement 进展的受限重试继续有效。
7. 提前量容纳普通地图/回读准备，压缩后可继续完成任务；对比原生路径的真实 input/output usage、额外请求、缓存及延迟。

## 实现依据

- 执行时机：[Loop pre-step](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L267-L285)、[Basic pressure hook](../../../deepseek-harness/packages/compaction/compaction-basic/src/index.ts#L158-L176)及 [model-switch 空步骤条件](../../../deepseek-harness/packages/core/agent/src/model-selection.ts#L113-L125)。
- 提醒落档：[source/form 定义](../../../deepseek-harness/packages/llm/llm/src/message.ts#L86-L132)及 [首次 attempt 落档](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L391-L407)。
- 状态恢复：[同步计量](../../../deepseek-harness/packages/llm/token-meter/src/index.ts#L146-L190)及 [Query observation](../../../deepseek-harness/packages/session-query/session-query/src/observation.ts#L22-L61)。
- 阈值：[原生 H 计算](../../../deepseek-harness/packages/compaction/compaction-basic/src/config.ts#L172-L194)、[O 默认规则](../../../deepseek-harness/packages/compaction/compaction-basic/src/index.ts#L59-L67)及 [模型信息查询](../../../deepseek-harness/packages/llm/llm/src/index.ts#L731-L745)。
