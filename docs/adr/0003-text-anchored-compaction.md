# ADR 0003：原文字面锚点与完整工具对选择

- 状态：Accepted（已采纳）
- 提交与清理生命周期：[ADR 0001](<0001-active-compaction-submission.md>)。

## 背景

工作模型掌握独特原文时，可以直接表达区间边界，无需先取得地图或维护另一套 ID／seq 选择接口。工具对属于宿主掌握的消息结构，由宿主自动补齐，模型只需提供语义边界和摘要。

## 决策

### 两个原文端点

context_compress 只操作当前调用 Session，每项包含 range 的两个 endpoint（text 和可选 role）及非空 summary。主提示词与 range schema 明确使用：

> range[0] identifies the start node and range[1] identifies the end node. The start must be at or before the end in current context order. Both endpoint nodes and all nodes between them are selected in full. If both endpoints identify the same node, only that node is selected.

顺序按当前 Surface 位置，不按内部 seq 数值。端点定位的是完整节点，不提供节点内字符替换、edge 或 occurrence。

匹配搜索当前 deriveEventMessage 的单个可作端点 text block，包含普通工具结果文本。source 归属的 acp-pressure notice/map、acp-maintenance 状态及精确 tool-call 关联的 context_compress tool/result 退出端点候选；普通 notice、其他工具结果与真正 compact-checkpoint 摘要保留。展示节点仍参与 range 内包含、工具跨度补齐、保护与冲突；不按正文猜测来源。大小写敏感 literal substring，不 trim、不做空白／Unicode 规范化、不跨 block 拼接；端点非空，空白是字面文本。reasoning、工具参数、Log、附件占位和 provider wrapper 不参与匹配。role 只限制该端点候选，不过滤区间内部。

同节点内重复或多 block 命中算一个候选；不同节点重复则该 region 失败。两个端点各自扫描完整当前 Surface，不默取 first/latest 或起点后的第一个终点。缺失或歧义报告候选数量、有界匹配附近正文与实际 role，工具结果附其实际 call 名称及 read 的 offset／limit；元数据只用于诊断，不增加端点协议（详见 README）。模型据此换词；倒序也归属于该 region。其他独立合法 region 继续。

### 自动补齐工具对

端点解析后，宿主按当前派生消息的实际 tool-call occurrence 与 tool result 配对，向外扩展区间直到闭包。选择一个结果会纳入对应 assistant；同一 assistant 中的所有调用必须纳入各自结果。调用到结果的跨度只要与选区相交就纳入闭包，因此选中的纯文本节点若夹在调用和结果之间，也会补齐整个跨度。扩展夹入的其他消息及其工具对继续求闭包。缺失对应当前调用或结果使该 region 失败，不通过 Log 复活已替换节点，不另加模型接口。

扩展完成后检查整个区间的保护和跨 region 冲突，保护不可绕过。共享节点的所有参与 region 都失败，相邻但不共享节点的 region 可独立提交，不自动合并；即使其中一项因保护或对应事件缺失失败，其已知范围仍参与冲突检查。预检使用原生 balancedBefore/After 检查完整切点；无法补齐时是该 region 失败，不使其他独立合法项停止。未冲突的合法 region 继续。结果保留原 range 和 expanded，node_count 给出实际选区规模。

### 保护线索与安全重选

保护拒绝展示真实任务／指令正文，保留 role、全部 reasons、blockers 总数与有界摘录；relay sender 包装不代替任务正文。对历史 instructions、latest task/checkpoint，建议从原始 range 内找最大可选片段：按工具跨度闭包排除触保护、缺配对或越出原选区的节点，再验证原生 balanced 切点及全 Surface literal 唯一性。片段端点使用实际 text+role，最多四项，并给出遗漏或无法提供原因。current_step 硬拒绝不提供拆分。

地图唯一性、split 端点唯一性与实际 matcher 共用候选过滤，避免 ACP 展示自身复制原文后制造歧义。JSON 中仍输出正常 text+role 字符串，不增加定位接口。建议不执行压缩、不猜摘要；模型分别写摘要再提交，选区内仍可细选。

### 同步采样与固定目标

宿主通过 Query captureSession 同步取得当前 Surface、事件、派生正文及计量。borrowed reader 不跨 callback 保留，执行资料由宿主分离保存。总结构／摘要预算先全局校验，然后各 region 独立验证；所有已知范围的冲突检查在执行之前完成。

定位只承诺本次采样的节点；旧正文被 checkpoint 替换后，同一句若唯一命中 checkpoint，选择的就是该当前节点。没有跨调用旧文本 hash、ID fallback 或猜测性重映射。

每项执行前重验固定目标的存活、顺序、事件、派生内容、保护与配对。局部目标变化归属于该项，不重新匹配另一个节点。原生事务的 whole-surface 校验继续生效；未知故障或取消停止，成功不回滚。

## 取舍与风险

literal 短原文和可选 role 消除必经地图调用与第二套定位协议，同时接受重复、无 text、复制偏差和旧正文已被替换导致的失败。历史回读仍使用已有 read/search/trace 工具；search 是索引 FTS，不作为字面匹配器，也不以扫描日志兜底。

工具对补齐可能扩大模型语义选区，因此显式报告 expanded，并在扩展后重新检查保护与冲突。摘要仍由工作模型负责语义完整性，保留结论、名称与路径、修改及验证证据、失败、未解决项、约束、不确定性和回读入口。宿主不另调用模型重写摘要。

完整原 range 会占用结果与清理记录预算；端点宜用足够独特的短语，不必复制整条消息。清理预算不足时保留原工具对，绝不裁短真实参数。原文定位、回读、摘要与前缀替换都有成本，不承诺固定 tokens、缓存、延迟或费用收益。

## 验证

测试涵盖同节点／多 block 命中、缺失／歧义／倒序、当前 checkpoint 位置、工具对向外扩展、多调用与夹入工具闭包、扩展碰保护或跨 region 冲突，以及一个 region 失败而其他独立合法项提交。录制回放与真实 Loader/Loop 检查提交、短状态记录和后续任务；成品验证见[交付指南](<../delivery.md>)。
