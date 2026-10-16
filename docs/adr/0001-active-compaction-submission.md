# ADR 0001：主动压缩的提交与生命周期

- 状态：Accepted（已采纳）
- 定位与工具对补齐规则：[ADR 0003](<0003-text-anchored-compaction.md>)。

## 背景

工作模型选择已完成的历史并撰写摘要，宿主验证和提交完整节点区间。一次独立调用可提交多个不重叠 region；某个 region 不合法，不应阻止其他独立合法工作落档。压缩提交、工具最终结算和调用／返回清理分别有自己的成功条件。

## 决策

### 原生事务与保护

采用薄 BasicCompactionEngine 子类替换唯一 compaction provider。预写摘要只覆盖 summarize 扩展点，复用原生 framing、缩水判断、计量与 start/summary/replacement/end 事务；普通自动压缩、pruner 和 overflow 委托基类。作者 provider/model 来自本次正常落档 assistant，不增加辅助模型请求或 usage。

模型必须在独立 assistant 响应直接调用一次 context_compress，使用 native/both，可带 reasoning，不带任务正文、其他调用或 run_code/PTC。guard 只拒绝压缩调用，混合批次的普通兄弟工具仍按原生规则执行；注册随插件 effect 撤销。

保护整个实际选区内的当前 system/developer、当前 Step、最新任务输入、承载该输入的存活 checkpoint 和所有 form:instructions。最新任务来源由配置启用；notice 不创建新任务，agent-message 仅 relay 创建任务。checkpoint 按 sourceEventSeqs 延续任务保护，直到出现更新的任务输入。

### 逐项验证与尾到头执行

批数、参数结构、总摘要预算或调用身份无效时整批拒绝。宿主在一次 Query capture 中固定当前 Surface、事件、派生消息和计量；逐项解析、补齐穿越选区的完整工具跨度、确认原生切点平衡、检查保护，并标记跨 region 冲突。缺失配对时保留已知范围参与冲突检查。端点、保护与配对错误归属于该 region；扩展后共享节点的所有参与 region 都失败，相邻但不共享节点的 region 可独立提交。通过预检的项按初始 Surface 尾到头执行。

执行前重验固定目标的存活、顺序、事件、正文与保护，不以原文本重新匹配另一个节点。可归因的选区错误与原生摘要不缩水继续后面的独立项。原生缩水错误以已关闭失败事务及其固定错误前缀识别；Basic 没有公开该错误类型，因此不将任意 Error 视为可恢复失败。取消、未知宿主／原生故障或无法确认的提交停止余项；未知故障仍成为最终工具错误，不静默降级为正常结果。

结果按原 input_index 列出 range、仅扩展时出现的 expanded: true、status、计量和原生回读 seq，另列 execution_order。批级 `status`：`compressed` 为全部提交且调用成功，`partial` 为提交与失败并存（包括提交后工具层失败），`failed` 为无一提交。部分失败／全部失败分别抛出 `ACP_PARTIAL`／`ACP_ALL_FAILED`，让工具层 isError 与正文一致；工具调用自身的取消或故障单列 `call_error` 与 `final_error`，因此失败不会被报成成功。逐项 `status`：failed 为该项验证或执行失败，not_attempted 为停止后未执行项；committed 为已确认 replacement。原生结束失败但 replacement 已确认时保留 committed_with_error；无法确认时标 unconfirmed。成功不回滚。存在 failed/not_attempted 项时才给 `retry.regions`，只重新选择这些项；成功项的旧端点不保证再匹配。

### 最终结算与工具对清理

execution-local facts 保存真实提交证据，finalizeContent 将其附到取消或后置策略错误中，保留最终 isError 和 ABORTED 等原因。只有观察到原生 replacement 才确认提交，不能仅凭返回对象伪造成功。

全成功或可归因部分失败（ACP_PARTIAL）的结果完整落档、Step 已结束且至少一个 region 已确认提交时，下一 pre-step 在原生压力处理前清理精确相邻的 assistant/result 两节点。全成功和部分成功使用同一规则。其他最终工具错误、取消、unconfirmed、无成功、节点已替换或独立调用资格不满足时保留原工具对。重启或卸载丢弃内存候选，不增加持久恢复队列。

维护记录包含全批原 input_index/status/range（完整 text 与可选 role）、扩展时的 expanded: true、失败或未执行原因、停止原因及原 assistant/tool-call/result Log seq；不包含 summary。完整结果与维护记录中的已确认提交项均附 source_session_id/source_start_seq/source_end_seq，取已观察到 replacement 的原生 summary.shadowedSeqs 首末节点及调用会话，包含工具对闭包后的实际范围；失败、未执行、unconfirmed 不附来源范围。来源范围不是事务或工具调用位置，Log 中间可能包含不在该 Surface 区间的事件。记录说明仅重选失败或未执行项。摘要留在 checkpoint；原始参数和结果留在 Log，替换关系可回放。

记录生成时按最近 request/header 匹配已启用的 pressureRoutes；通过提醒器的 hasPendingReminder 读取同一份 session-local episode，包含已有的原始 Log 恢复和实时低于 R 复位，不新增独立状态。使用 token-meter 当前 totalTokens 减去旧工具对的路由 tokens、加上候选短记录及反馈正文估计量，判断替换后的档位。已提醒且尚未复位时以 R 为本轮降压目标，明确区分继续压缩与目标达成；无未复位提醒时，低于 S 不要求继续压缩，也不声称完成原本没有的目标，达到 S 才建议继续降压。完整文案规则见 README。路由未启用则不附压力反馈；工具对替换只读取 episode，不改变独立提前提醒的去重与复位。反馈计入完整 confirmation 预算，不能容纳则保留原工具对。

确认预算针对完整消息（含包装）计量，默认 1200 tokens/8000 UTF-8 bytes，可配置。完整记录不满足任一预算时保留原工具对；不裁短真实端点、不舍弃逐项原因，也不降为只有 seq 的记录。该预算覆盖普通短锚点批次，不承诺容纳所有合法长参数。完整工具结果也受 resultMaxBytes 约束，首次写入前预留完整原 range 和回读 seq 所需空间；无法容纳则在提交前报预算错误。

清理连续同步追加 compaction/prune 与 user-role replacement。prune 只在紧邻 replacement 消费后扣减计量；第二次 append 失败会抛出宿主错误、保留原节点，孤立 prune 不影响回放计量。

## 取舍与风险

逐项事务没有批次回滚，避免新增跨事务恢复协议；中断留下的原调用／返回可继续诊断。状态记录完整性优先于强制去重，因此长端点或长错误可能保留摘要参数副本。原生 whole-surface 检查仍生效，单次事务期间选区外变化也可能被拒绝。每项原生压缩仍可能扫描完整 Surface，成本随项数增长。

## 验证

测试执行真实 Loader/Loop 的相邻／非相邻提交、独立失败继续、全局预算拒绝、原生缩水失败、未知异常及取消结算、工具对清理与 replay；短记录保留完整原 range/status/error 和 Log seq，不重复 summary。完整成品解析与 peer 身份通过[隔离交付验证](<../delivery.md>)检查。
