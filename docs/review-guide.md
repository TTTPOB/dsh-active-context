# ACP 行为核对

本文说明 ACP 的行为边界与验证入口。日常接口、默认值与运行条件见 [README](<../README.md>)，打包后验证见[交付指南](<delivery.md>)。定位规则以 [ADR 0003](<adr/0003-text-anchored-compaction.md>)为准；提交与清理规则见 ADR 0001，提醒生命周期见 ADR 0002。

## 当前正文选区

`context_compress` 在本次调用内通过 Query `captureSession` 同步读取当前调用会话的 Surface、派生消息、事件和计量。borrowed reader 只在 callback 内使用，执行目标以分离后的完整节点资料固定。每个端点分别扫描全部当前派生 text block；匹配按节点合并，不能截断扫描后冒充唯一。

两个端点包含完整节点，可以位于同一节点；顺序以 Surface 位置解释，不以内部 seq 排序。工具结果正文可以匹配；宿主自动向外补齐调用／结果，包含同一 assistant 的全部调用、穿越纯文本选区的完整工具跨度及扩展夹入的工具对，直到完整闭包。已知缺失配对范围仍参与双方冲突检查；原生切点平衡在预检确认。扩展后再检查保护和跨 region 冲突。缺失或歧义诊断只含有界原文线索与 role，供模型重新选词。普通历史搜索仍是索引 FTS，不承担字面选区，也不以日志扫描补偿索引失败。

整体预检固定全部目标后，每次执行前重验原有节点的存活、顺序、事件、派生内容、保护与配对。目标变化使该 region 失败，其他独立合法项仍可继续；不重新匹配同一句话指向另一个节点。普通尾部追加或选区外变化不引入全局 freshness 门槛，单项原生事务仍执行自己的校验。

## 提交、结算与清理

一条独立 native/both 调用可提交多个非相邻区间。批数、参数结构、总摘要预算和调用身份先全局校验；各 region 独立验证。端点／保护／工具配对错误只使该项失败，扩展后相邻／重叠的所有参与项都失败。其余项从尾到头提交，可归因的选区或原生缩水失败继续，取消、未知故障或不确定提交停止余项；已提交项不回滚。部分成功、取消或 replacement 写入后的错误保留实际提交事实，结果按输入索引关联，并列出实际尝试顺序。

保护当前 system/developer、当前 Step、全部存活 instructions，以及最近任务输入和承载它的存活 checkpoint。准入 guard 根据正常落档的 assistant 身份及实际 tool-call blocks 校验独立调用，混合批次、重复调用、缺失身份和 PTC 在压缩事务前拒绝；普通兄弟工具仍按原生调度执行。

工具 body 完成不等于最终成功。最终落档结果正常，至少一个已确认提交且无不确定项，调用与结果仍是精确相邻存活节点时，下一 Step 才清理工具对，支持部分成功。清理前重启丢弃内存候选、留下原消息；已经写入的替换由 Log 回放。短状态记录完整保留各项原 range/status/input_index/expanded、失败或未执行原因及原调用／返回 Log seq，不重复 summary。完整记录超预算保留原工具对，不截断端点。原作者、参数、结果及事务始终保留在 Log。

## 压力提醒与原生兜底

每次正常请求依次执行：成功工具对清理 → 原生压力处理 → ACP 重测 → 本次提醒。默认 `pressureRoutes: []` 不启用提前提醒。显式启用路由须满足 `R < S < H`；完整英文提醒含消息包装、约数 T、原生阈值 H 及行动建议，预算不足直接报错，列出实际估计 tokens、UTF-8 bytes 与配置上限，不降级为短提醒。

每段持续高压只提醒一次，实际提醒落档才消耗资格，实时计量 `T < R` 后复位。reload/resume/HMR 后当前低于 R 直接复位，否则从当前 Session 原始 Log 一次扫描恢复已提醒状态。正常步骤使用内存状态，不写 reset 事件或重建历史压力。降压再升高、第二条提醒落档前恰好重启时，可能沿用旧的已提醒状态，直到再次测得 `T < R`。

## 源码验证入口

ACP 与 Harness 源码位于同一父目录，Harness 提供 Vitest、TypeScript、测试依赖及 vendor 声明产物。在 ACP 根执行：

```sh
node tests/typecheck.mjs
node tests/run.mjs text-ranges partial-regions regions protection provider compaction-loop compaction-failures recorded-replay guard hide reminder
```

[严格类型检查](<../tests/typecheck.mjs>)检查 ACP 源码及测试，不过滤诊断；[测试入口](<../tests/run.mjs>)使用源码路径别名和既有 Loader、Loop、delivery helper。测试临时目录自动清理，源码验证不替代[打包后隔离安装](<delivery.md>)。

关键行为包括：字面唯一性、缺失与歧义、同节点与多 block、当前摘要替换、逐项失败继续与全局预算拒绝、工具对自动闭包及扩展后保护／冲突、独立调用 guard、双非相邻原生提交、局部执行失败继续与不可恢复故障停止、错误结算事实、部分／完整成功工具对清理、长参数超预算保留原对与 replay，以及提醒计量、去重和恢复。模型可见输出通过[录制回放](<../tests/recorded-replay.spec.ts>)消费真实嵌入 assistant streams、比较完整规范化 Log，并检查下一请求和最终回答。

源码、成品解析和真实模型质量分别验证。实际预算与成本需结合工作路由、usage、缓存及延迟评估，不能由确定性 fixture 推断固定收益。
