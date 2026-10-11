# ADR 0001：主动压缩的提交与生命周期

- 状态：Proposed（提议）
- 实施情况：未实现。
- 归属：树外 Cordis 插件 dsh-active-context。

## 背景

ACP（Active Context Pruning，模型主动裁剪上下文）让工作模型选择已处理的历史并写好摘要，由宿主验证后替换原区间。压缩需要保留继续工作的必要信息，并降低包括摘要、工具交互和后续请求在内的总成本。

[通用地图](../../../dsh-session-tools/docs/adr/0004-context-map-and-metering.md)提供 Surface 位置、回读入口和 token 计量。ACP 必须依赖 token-meter，以实际计量输入执行判断；负责选区保护、摘要提交和成功调用后的清理；[提前压力提醒](0002-pressure-notices.md)单独记录。

## 决策提案

### 使用方式

模型在一条独立 assistant 响应中直接调用一次 `context_compress`。一次调用可提交多个非相邻区间，每个区间有自己的摘要；宿主逐项原位替换，中间未选内容保留，原始 Log 可继续回读。

压缩调用使用 native 或 both 通道，不能与其他工具同批，也不能放进 run_code/PTC。响应可包含 reasoning，但不附需要保留的任务正文。多区间通过同一次调用的 `regions` 提交。

首版包含成功调用的工具对清理：全批成功且最终工具结果正常时，把含摘要参数的 assistant 消息及结果消息替换为短确认。失败、部分成功和取消保留原工具对及诊断。

### 输入与整体预检

调用接受同一 `snapshot_ref` 下的 `regions`。`snapshot_ref` 包含 `session_id`、包含上界事件的 `read_seq`（空源为 -1）和诊断用 `map_id`；每项包含唯一短 id、start/end anchor（`{seq, edge}`，edge 为 `before` 或 `after`）和非空文本 summary。压缩只作用于当前会话，区间按 Surface 位置解析，`map_id` 不用于查找缓存快照。

开始任何压缩事务前，整体检查全部区间：

- 端点存活，区间非空、互不相邻且不重叠、不重复。
- 工具调用与结果配对完整，所选内容符合保护规则。
- 当前调用作者已经正常落档，IDs 和摘要总预算合法。

预检失败时整批拒绝。相邻区间需由模型重新选择；超预算摘要拒绝提交，保留原文供修改。

### 受保护内容与摘要要求

保护当前 system/developer、当前 Step、最近任务输入和全部存活 `form:instructions`。开放 Turn 中已经完成的旧步骤仍可压缩。

最近任务输入覆盖配置中启用的 user、agent-message/form:relay、goal、schedule 来源；user 包括子代理初始委派。维护 notice 不作为任务输入，其他任务型来源可配置加入。checkpoint 的创建 Step 与它概括的历史分别判断。

摘要保留结论、关键修改及位置、结果和验证证据、失败原因、未解决问题、约束与不确定性，以及继续工作需要的精确名称、路径和回读入口。模型负责摘要语义，宿主负责结构与保护规则。

### 取图后发生变化怎样处理

提交时按当前 Surface 重找端点和区间，并结合采样读取上界检查区间内是否出现取图后新建的替换节点。端点或中间目标已被替换时，要求刷新地图。

普通尾部追加及选区外替换不直接使目标失效；ACP 按所选目标检查，而非以全局 generation 判断整张地图是否过期。

取图至整体预检之间，插件改写同一节点的投影文字但保留 seq 的情况不在本方案考虑范围内；不为此保存旧正文或增加跨调用内容比较。整体预检固定当前目标消息后，逐项执行前仍检查这些消息是否改变。

### 多区间执行与失败行为

按初始 Surface 从后向前执行。预检保存各目标的有序 seq、不可变原事件与解释后消息引用、计量数据和保护信息；每项执行前重找剩余目标，检查取消、顺序、内容、保护及工具配对。

自身替换后，尚未执行的区间按原目标重新定位。首个执行失败或目标变化即停止余项；已提交项保留，不回滚。结果按输入顺序列出，并另给实际执行顺序。

| 结果 | 行为 |
|---|---|
| 全部正常提交 | `batch_success`，返回逐项 compaction ID 和回读入口 |
| 已有提交，随后失败或目标变化 | `partial`，保留已提交项，余项为 `not_attempted` |
| 执行失败且没有 replacement | `all_failed`，返回原错误和停止原因 |
| 取消 | 停止余项，诊断中保留实际提交事实；最终工具结果可为 `ABORTED` |
| replacement 已写入，随后原生提交抛错 | 标记 `committed_with_error`；无法确认时明确标为未确认，停止余项 |

结果正文包含各项 id、顺序、状态、compaction ID、节点数、定位及停止原因，并区分路由计量下的缩水结果和被替换消息的启发式计量。重试前刷新地图，只重新选择失败或未执行项。

### 成功工具对清理

主压缩结束时，工具报告“已提交，清理待结算”。下一 Step 的 pre-step 阶段，在原生压力检查之前确认以下条件：

1. 上一 Step 已结束，全批提交成功，最终落档的工具结果无错误、取消或 partial。
2. assistant 消息恰有本次调用，调用 ID、结果来源引用和执行身份一致。
3. assistant 与结果仍是 Surface 上相邻的两个存活节点。

满足条件后，以短维护消息替换这两个节点。短确认只保留压缩完成、有界 compaction IDs 和必要回读入口。原 assistant、tool/call、tool/result 和压缩事务均留在 Log，替换记录支持回放。

匹配失败时保留原工具对。清理前取消、卸载或重启会丢弃内存候选、留下原消息；已完成的清理由日志恢复。正常执行应在下一模型请求前完成清理。

## 实现方式

### 复用原生压缩 provider

使用薄 `BasicCompactionEngine` 子类替换唯一 `ctx.compaction` provider。通过 `summarize()` 返回模型预写摘要，其余复用原生范围校验、摘要包装、缩水判断、计量和事务。普通压缩委托基类，保留 auto:true、pruner 和 overflow fallback。

每项执行临时设置摘要，调用 `super.compactRegion`，finally 清除；同 Agent 不嵌套覆盖。摘要作者使用发起调用的已落档 assistant 的真实 provider/model。预写摘要不产生额外摘要模型请求或独立 usage，每个区间形成一套原生 start/summary/replacement/end 记录及 checkpoint。

ACP 与 Basic 配置分开。子类使用包根公开类和可消费类型，内部摘要类型可用公开结构或类型推导表达。

### 独立调用校验与取消诊断

同步 session/event 通知只读记录当前 Step 正常落档、非 interrupted、append 类型的 assistant 身份和实际 tool-call blocks。公开 `ctx.tools.guard` 校验唯一调用、ID/name、无 transport parent、rootCallId 等于 callId，以及可接受的响应内容；缺身份或内容不符合规则时拒绝。blocks 按实际数量检查，不能先去重再计数。

guard 在审批后、工具 body 前运行，只拒绝压缩。混合批次中的普通兄弟工具仍按原生调度执行；拒绝正常落档，保留其参数和错误。Step 结束清理身份缓存，工具与 guard 随插件 effect/HMR 撤销。

执行期间用 execution-local WeakMap 保存逐项事务事实。工具 body 成功后仍可能被取消或后置处理改为错误；通过既有 `finalizeContent` 把已提交事实附到最终错误正文，保留原 `isError` 和 `ABORTED` 状态。

### 清理记录与计量

待清理候选按 Agent/session 保存 turn、step、callId、assistantSeq、toolCallSeq、resultSeq 和 compaction IDs。资格以最终落档的 tool/result 为准；完成或确定无法清理后移除候选。

首个写入前准备短确认及其来源，使用 `tokenMeter.estimateMessage` 对两条原消息做启发式计量。连续无 await 追加 `compaction/prune` 和 user-role replacement：精确记录两个 shadowed seq、计量及来源引用；维护消息声明自有 `source.kind: acp-maintenance`、`form: notice` 和有界 `source.summary`。

两条记录在 pre-step 写入，session/event 回调只记录事实。prune claim 由紧邻的 replacement 消费；若第二次写入失败，报告宿主提交错误，孤立 prune 不直接扣减 token 数。

## 理由与替代方案

- **增加核心预写摘要 API。** 可以保留另一 compaction provider，但现有 summarize 扩展点已经能复用原生事务；采用树外薄子类。
- **原子批次或自写事务。** 需要额外回滚、恢复和回放协议；逐项原生事务满足多区间需求，接受部分成功不回滚。
- **放行混合/PTC 后局部改写调用消息。** 需要保留任务正文、兄弟调用、程序及 provider 配对状态；采用独立调用和整对替换。调度器的 exclusive 只控制执行顺序，不能保证消息中只有压缩调用，因此使用 guard 校验。
- **只返回空结果或修改 renderer。** assistant 中的摘要参数仍占上下文；需要同时替换调用和结果消息。
- **增加摘要评审模型。** 增加调用成本；采用摘要保留规则和连续任务评测检验语义质量。
- **持久恢复队列。** 增加批次与清理恢复状态；原生事务记录保留提交事实，未清理的工具对可诊断，接受中断后保留原消息。

## 后果与风险

子类占用唯一 compaction provider。原生 `compactRegion` 的 current-turn、ownership、锁和 whole-surface 校验继续生效：单次调用期间，选区外 Surface 变化也可能导致拒绝。whole-surface 比较节点和计量值，正文一致性由 ACP 从整体预检开始另行检查。首版仅在活动 Turn 中调用原生 region，不扩展 idle 任意区间提交。

清理使用相邻两次 append，不是跨事件原子提交。两条之间中断时，日志可能只留下 prune 记录，需要保证回放和后续计量正确。

原生每项压缩仍重建摘要输入并可能扫描全 Surface；成本随区间数增长，不承诺只处理所选节点。

摘要提交、工具最终结算和工具对清理是三个不同结果。清理失败会留下摘要参数副本；即使清理成功，摘要生成、schema、地图、提醒和短确认仍有开销，历史前缀替换也可能影响缓存命中。

## 预算与验收

maxRegions 至少允许 2，同时限制摘要总 tokens/UTF-8 bytes、结果和短确认长度。骨架完成后用本机会话粗测，选取适合日常工作的默认值。

1. 双非相邻区间按 Surface 从后向前替换，中间内容保留；目标保护、工具配对、整体预检和超预算拒绝有效。
2. 自身替换后余项可继续；预检后同计量值的目标内容变化能被识别；选区外变化与单次原生校验分别符合上述规则。
3. 部分成功、取消及 replacement 写入后的错误保留真实提交事实；摘要槽清理，普通自动压缩继续正常工作；预写摘要不额外发起摘要模型请求，作者路由准确且不重复计入 usage。
4. 独立 native/both 调用放行；混合批次、双 compress、重复调用 ID、缺身份和 PTC 调用在事务前拒绝，普通兄弟工具保持原生行为。
5. 仅最终全成功且精确相邻的工具对被清理；错误、取消、正文、已替换节点及两次 append 中断不造成误删或错误计量，reload/replay 一致。
6. 发布包导入、peer 单例、唯一 provider 和真实 Loader 时序可用；关键模型可见输出使用现有 keyless snapshot 验证。
7. 压缩后继续完成修改和验证，保留关键约束与未解决项；对比原生路径的实际 usage、额外请求、缓存及延迟。

## 实现依据

- 清理依据：[参考实现的整对替换](https://github.com/Tyan66666/billion-context-dsh/blob/91a8a1e581927d68511caf0678419a45040f2245/src/region.ts#L815-L904)及其[结果回调触发点](https://github.com/Tyan66666/billion-context-dsh/blob/91a8a1e581927d68511caf0678419a45040f2245/src/index.ts#L453-L470)。本提案使用上述 pre-step 清理时机与有界短确认；参考实现不作为本插件运行验收证据。
- provider：[公开类](../../../deepseek-harness/packages/compaction/compaction-basic/src/index.ts#L108-L141)、[summarize 扩展点](../../../deepseek-harness/packages/compaction/compaction-basic/src/index.ts#L237-L257)及[动态调用](../../../deepseek-harness/packages/compaction/compaction-basic/src/index.ts#L437-L448)。
- 目标检查：[原生 region 校验](../../../deepseek-harness/packages/compaction/compaction-basic/src/region.ts#L173-L213)、[whole-surface 比较](../../../deepseek-harness/packages/compaction/compaction-basic/src/region.ts#L430-L439)及 [Session 消息解释](../../../deepseek-harness/packages/core/session/src/index.ts#L842-L890)。
- 准入：[guard 注册](../../../deepseek-harness/packages/core/tools/src/index.ts#L1126-L1141)、[PTC 身份](../../../deepseek-harness/packages/core/tools/src/ptc.ts#L538-L554)及 [assistant 落档后调度](../../../deepseek-harness/packages/core/agent-loop/src/agent.ts#L495-L520)。
- 结算：[finalizeContent](../../../deepseek-harness/packages/core/tools/src/index.ts#L247-L258)、[body 成功后取消](../../../deepseek-harness/packages/core/tools/src/index.ts#L1559-L1589)及 [source/form 定义](../../../deepseek-harness/packages/llm/llm/src/message.ts#L86-L132)。
