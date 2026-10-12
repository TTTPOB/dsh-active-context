# ADR 0002：提前压力提醒与原生兜底共存

- 状态：Accepted（已采纳）

## 决策

提前提醒在原生自动压缩线之前，为工作模型准备摘要提供机会。每次正常模型请求依次执行：上一 Step 已确认提交工具对清理 → 原生压力处理 → ACP 重测 → 加入本次压力提醒。提醒不创建额外模型请求，拒绝、取消和原生跳过的空步骤保持原行为。

提醒以 user-role 维护消息正常落档，source.kind 为 acp-pressure、form 为 notice，并带有界 source.summary。英文正文给约数 T、原生自动压缩阈值 H、简短行动和当前保护边界地图。地图与压缩共用 Query capture 及保护函数；pre-step 使用真实 turn/step 位置，已完成的前 Step 不冒充当前执行 Step，不构造 assistant/call 身份。尚未落档的新输入／current entering Step 明确不在地图且不可选。计量继续使用 token-meter 的 usage baseline 与 estimated delta；baseline/delta 数字不加入提醒正文，不新增日志系统。

pressureRoutes 默认空，仅显式 provider/model 路由启用。每项配置提醒线 S（nudgeAtTokens）和较低复位线 R（resetBelowTokens），满足 0 <= R < S < H。H 取 Basic 对应路由策略：

```text
H = floor(min(C × thresholdRatio, C − O − headroomTokens))
```

C 为模型上下文容量；O 取工作请求 maxTokens 或 adapter 默认输出，两者未声明时为 0。路由取最近已落档 request/header，模型容量通过 llm.resolveModelInfo 查询。静态配置错误在加载时拒绝；容量未知或动态 R/S/H 不合法时诊断一次并跳过该路由提醒，原生处理继续。

每段持续高压只提醒一次，实际 user/message 落档才消耗提醒资格。实时 T < R 后复位；新 Turn、任务或路由延续 session-local 状态。恢复时当前低于 R 直接复位，否则从原始 Log 一次扫描已落档提醒；正文被压缩不影响恢复。正常步骤使用内存状态。

地图只列当前存活保护节点，连续同类节点合组并按 Surface 位置排列。分类按 current_step → instructions → latest_task_input/checkpoint 优先级处理多原因；B 标签只在本张地图有效。短原文优先正文，按实际 role 检查单 block literal 唯一性；找不到有界唯一片段时如实标注。段内可任意细选，保护地图不生成摘要或规定压缩范围。

完整提醒及消息包装受 reminderMaxTokens/reminderMaxBytes 约束；优先列最新任务／checkpoint 承载组，余量容纳其他组。遗漏时明确组数与节点数，并提醒还有未列边界。核心行动及遗漏说明超预算生成失败，报告实际 tokens/bytes 与上限，也不消耗本次资格。默认值由[配置](<../../src/config.ts>)定义。

## 取舍与风险

保留原生 pruner、自动摘要及 overflow，不增加跨阈值宽限或抢先调度。单步上下文增量或切换小容量路由可能直接跨过 S/H，原生兜底先处理。

复位只更新内存，不新增 reset 事件。若经历已提醒→降压→再次升高，第二次提醒落档前恰好重启，可能延续旧已提醒状态直到再次测得 T < R。此单机窗口不足以引入历史压力重建和恢复队列。

pre-step 的计量可能尚未包含 pending 输入或后续系统提示词更新；提醒提供准备机会，不替代请求容量检查。提醒、回读和摘要都有开销，阈值按真实工作路由校准，不承诺固定成本收益。

## 验证

覆盖持续高压去重、落档前取消／拒绝、低压复位、reload/resume/HMR、原生执行顺序、完整英文正文与预算、空步骤抑制、原生压力与 overflow 生命周期。源码与成品入口见[行为核对](<../review-guide.md>)和[交付指南](<../delivery.md>)。
