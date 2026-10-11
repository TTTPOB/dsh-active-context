# ACP 行为核对

本文说明 ACP 的行为边界与验证入口。日常接口、默认值与运行条件见 [README](<../README.md>)，打包后验证见[交付指南](<delivery.md>)。定位规则以 [ADR 0003](<adr/0003-text-anchored-compaction.md>)为准；提交和提醒的生命周期沿用原 ADR 中未被替代的部分。

## 当前正文选区

`context_compress` 在本次调用内通过 Query `captureSession` 同步读取当前调用会话的 Surface、派生消息、事件和计量。borrowed reader 只在 callback 内使用，执行目标以分离后的完整节点资料固定。每个端点分别扫描全部当前派生 text block；匹配按节点合并，不能截断扫描后冒充唯一。

两个端点包含完整节点，可以位于同一节点；顺序以 Surface 位置解释，不以内部 seq 排序。工具结果正文可以匹配，但仍须完整选择调用与结果；宿主不自动扩界。缺失或歧义诊断只含有界原文线索与 role，供模型重新选词。普通历史搜索仍是索引 FTS，不承担字面选区，也不以日志扫描补偿索引失败。

整体预检固定全部目标后，每次执行前重验原有节点的存活、顺序、事件、派生内容、保护与配对。目标变化则停止，不重新匹配同一句话后继续。普通尾部追加或选区外变化不引入全局 freshness 门槛，单项原生事务仍执行自己的校验。

## 提交、结算与清理

一条独立 native/both 调用可提交多个非相邻区间。全部目标、摘要预算和调用身份先预检；随后从尾到头逐项提交。首个执行失败或目标变化停止，已提交项不回滚。部分成功、取消或 replacement 写入后的错误保留实际提交事实，结果按输入索引关联，并列出实际尝试顺序。

保护当前 system/developer、当前 Step、全部存活 instructions，以及最近任务输入和承载它的存活 checkpoint。准入 guard 根据正常落档的 assistant 身份及实际 tool-call blocks 校验独立调用，混合批次、重复调用、缺失身份和 PTC 在压缩事务前拒绝；普通兄弟工具仍按原生调度执行。

工具 body 完成不等于最终成功。只有全批成功、最终落档结果正常，且调用与结果仍是精确相邻存活节点时，下一 Step 才清理工具对。清理前重启丢弃内存候选、留下原消息；已经写入的替换由 Log 回放。短确认附必要压缩记录回读入口，原作者、参数、结果及事务保留在 Log。

## 压力提醒与原生兜底

每次正常请求依次执行：成功工具对清理 → 原生压力处理 → ACP 重测 → 本次提醒。默认 `pressureRoutes: []` 不启用提前提醒。显式启用路由须满足 `R < S < H`；整条提醒含消息包装、压力与计量依据及短行动建议，预算不足时只保留短压力信息。

每段持续高压只提醒一次，实际提醒落档才消耗资格，实时计量 `T < R` 后复位。reload/resume/HMR 后当前低于 R 直接复位，否则从当前 Session 原始 Log 一次扫描恢复已提醒状态。正常步骤使用内存状态，不写 reset 事件或重建历史压力。降压再升高、第二条提醒落档前恰好重启时，可能沿用旧的已提醒状态，直到再次测得 `T < R`。

## 源码验证入口

ACP 与 Harness 源码位于同一父目录，Harness 提供 Vitest、TypeScript、测试依赖及 vendor 声明产物。在 ACP 根执行：

```sh
node tests/acceptance/typecheck.mjs
node tests/acceptance/run.mjs text-ranges regions protection provider active-loop active-failures recorded-replay guard hide reminder
```

[严格类型检查](<../tests/acceptance/typecheck.mjs>)检查 ACP 源码及测试，不过滤诊断；[测试入口](<../tests/acceptance/run.mjs>)使用源码路径别名和既有 Loader、Loop、delivery helper。测试临时目录自动清理，源码验证不替代[打包后隔离安装](<delivery.md>)。

关键行为包括：字面唯一性、缺失与歧义、同节点与多 block、当前摘要替换、全批拒绝无副作用、完整工具配对和保护、独立调用 guard、双非相邻原生提交、目标变化停止、错误结算事实、工具对清理与 replay，以及提醒计量、去重和恢复。模型可见输出通过[录制回放](<../tests/acceptance/recorded-replay.spec.ts>)消费真实嵌入 assistant streams、比较完整规范化 Log，并检查下一请求和最终回答。

源码、成品解析和真实模型质量分别验证。实际预算与成本需结合工作路由、usage、缓存及延迟评估，不能由确定性 fixture 推断固定收益。
