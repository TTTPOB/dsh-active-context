# dsh-active-context

ACP（Active Context Pruning，模型主动裁剪上下文）是树外 Cordis 插件。工作模型选择已处理的历史、提交自己的摘要；插件验证目标和保护规则后，复用原生压缩事务替换所选完整节点区间。原始 Log 保留，供后续回读。

## 使用流程

1. 为一个或多个不重叠区间选择两个独特原文端点，按需通过历史工具回读。每个端点包含 `text` 和可选的实际消息 `role`。
2. 为每个区间写非空 `summary`，保留结论、精确名称与路径、修改和验证证据、失败原因、未解决项、约束、不确定性及回读入口。
3. 在一条独立 assistant 响应中直接调用一次 `context_compress`，提交 `regions`。使用 native 或 both；该响应只包含这次工具调用及可选 reasoning，不带其他工具或任务正文，也不经 run_code/PTC 调用。
4. 查看逐项结果。`status` 只有三种：`compressed`（全部区间提交且工具调用成功）、`partial`（保留了提交，但有区间或工具层失败）、`failed`（无一提交）。部分失败与全部失败分别返回真正的工具错误 `ACP_PARTIAL`／`ACP_ALL_FAILED`，不会只在成功结果正文中写失败。工具调用自身的失败另列 `call_error`（`aborted`／`error`）与 `final_error`，所以取消、宿主故障或策略拦截既不会被报成成功，也不会被批状态掩盖。`input_index` 从零开始对应输入，`execution_order` 给出实际尝试顺序；只有存在 `failed`／`not_attempted` 项时才出现 `retry`（需要重选的输入索引与重选说明）。每项给出原 `range`、仅扩展时出现的 `expanded: true`、实际选区节点数 `nodes`、`shadowed_tokens`／`replacement_tokens` 以及可回读的 `readback` seq；token 数使用 token-meter 路由计量，分别在预检和提交后测量。不返回内部事务 ID、重复计量、节省比例或 cleanup 状态。执行从 Surface 尾部向前进行，选区错误或原生摘要不缩水只影响该项，其他独立合法项继续。取消、未知宿主故障或不确定提交停止余项，已提交项不回滚。只用当前正文重新选择失败或未执行项；成功项的原端点不保证还能匹配。

接口示意：

```json
{
  "regions": [
    {
      "range": [
        { "text": "先核对输入数据的来源", "role": "user" },
        { "text": "来源核对结束，保留两项未解决约束", "role": "assistant" }
      ],
      "summary": "保留核对结论、精确名称与路径、两项未解决约束及必要回读入口。"
    }
  ]
}
```

每个 `range` 恰有两个端点，按当前 Surface 位置指定起点和终点，包含两端的完整节点及中间全部节点；两端可以定位同一节点。每个端点独立匹配整个当前调用会话中可作端点的派生消息 text block，使用大小写敏感的 literal substring，不 trim、不规范化、不跨 block 拼接。端点必须非空，空白本身也是字面文本。同一节点内多次或多 block 命中只算一个候选；不同节点重复则拒绝，可换更独特原文或加 `role`。歧义诊断给出候选总数与最多四个候选的实际角色、匹配附近的有界正文；工具结果附其实际调用名称，`read` 仅附已记录的 offset／limit，不复制其他参数。`role` 只限定该端点，不过滤区间内部节点。

匹配按 source 排除 ACP 自生成的 acp-pressure notice/map 与 acp-maintenance 状态记录，按同一 turn/step 的实际 tool-call 关联排除 context_compress 自身 tool/result；普通 notice、其他工具结果及真实 compact-checkpoint 摘要仍可匹配。这些展示节点只退出端点候选，仍在 range 内参与包含、工具跨度补齐、保护与冲突检查。匹配不搜索 reasoning、工具参数、附件占位、provider wrapper 或原始 Log 文本，也不提供 regex、occurrence、模糊匹配或 ID 选区。正文已被替换时，只能命中当前摘要节点，不代表旧原节点仍存活。端点无匹配、歧义或倒序只使该 region 失败。批数、参数结构和总摘要预算错误仍拒绝整批。宿主解析端点后，自动向外扩展到完整 tool-call/result 配对；同一 assistant 的全部调用及扩展过程中纳入的工具对一起求闭包；即使只选中调用与结果之间的纯文本节点，也会补齐穿越该选区的完整工具跨度。当前正文缺失对应调用或结果时该 region 失败，已知范围仍参加冲突检查。宿主在预检确认原生切点平衡，不能补齐时仅拒绝该 region。

当前 system/developer、当前 Step、最近任务输入（包括承载该输入的存活 checkpoint）及存活的 `form:instructions` 受保护，包括选区中间的节点。自动补齐工具对后再检查整个区间的保护和跨 region 冲突，不能通过扩展绕过保护。保护拒绝返回阻挡节点总数、最多四个节点的角色、全部原因与真实任务／指令正文短摘录；无正文或无唯一短原文时明确标注。历史保护可附最多四个安全 split ranges：它们位于原 range 内，工具跨度完整、原生切点平衡且不触保护；可直接沿用解析后的端点，分别撰写摘要，也可进一步细选。没有合法片段时说明原因，current_step 硬拒绝不提供绕行建议。扩展后共享节点的所有参与 region 都失败，相邻但不共享节点的区间可独立提交，不自动合并，其他合法 region 仍可执行。冲突诊断区分完全包含、部分重叠与相同范围，注明输入索引方向和共享节点数；已因保护或缺失配对失败的已知范围仍参与冲突。结果保留原 `range`、`input_index`、逐项状态、扩展时的 `expanded: true` 和原因；`nodes` 为实际完整选区节点数。

最终工具结果正常落档、Step 结束且至少有一个已确认提交时，插件在下一 Step 原生压力检查前，用短状态记录替换相邻调用与结果节点，支持部分成功。记录完整保留所有 region 的原 `input_index`、状态、`range`（含可选 role）、扩展标记、失败或未执行原因，以及原 assistant/tool-call/result 的 Log seq；不重放 summary。完整记录超出任一确认预算时保留原工具对，不截断端点或只留下 seq。工具层故障（不含已确认的 `ACP_PARTIAL`）、取消、不确定提交、无成功、清理前重启或资格不满足时也保留原工具对。原调用与结果始终可从 Log 回读。

短状态记录使用最近已落档 request/header 匹配 `pressureRoutes`；扣除旧工具对、计入短记录后，若预估上下文仍达到提醒线 S，就在同一记录中提示继续压缩到 S 以下，不重复提交已成功项。低于 S 或路由未启用时不加此提示；不另发 acp-pressure 提醒、不修改持续高压去重和复位状态。提示连同完整记录受 confirmation 预算约束，放不下则保留原工具对。

## 配置与运行条件

ACP 替换唯一 `compaction` provider；使用时须禁用原 Basic provider。原生自动压缩、pruner 和 overflow 处理仍由插件内的 Basic 实现执行。依赖 Query `captureSession` 和 tokenMeter，不需要 session-tools；普通历史工具可独立启用。

配置分为 `acp` 和 `basic`：前者控制提交与提醒预算，后者控制原生压力策略。ACP 默认值：

| 配置 | 默认值 | 用途 |
|---|---:|---|
| `maxRegions` | 16 | 每批区间上限，至少允许 2 |
| `summaryMaxTokens` / `summaryMaxBytes` | 8000 / 32000 | 全批摘要总预算 |
| `resultMaxBytes` | 16000 | 工具结果预算 |
| `confirmationMaxTokens` / `confirmationMaxBytes` | 1200 / 8000 | 完整状态记录含消息包装的上限；超出时保留原工具对 |
| `reminderMaxTokens` / `reminderMaxBytes` | 1200 / 6000 | 整条压力提醒及消息包装预算 |
| `taskSourceKinds` | `user`, `agent-message`, `goal`, `schedule` | 最新任务来源；notice 不作为任务，agent-message 只认 relay |
| `pressureRoutes` | `[]` | 仅显式路由启用提前提醒 |

提醒使用英文，包含约数 T、原生自动压缩阈值 H、行动建议和最简保护边界地图。地图通过与压缩共用的 Query 采样及保护机制读取当前活 Surface；按位置列出 current_step、instructions（system/developer 或 form:instructions）和 latest_task_input/checkpoint，多原因按此优先级分类。连续同类保护节点合组，B1/B2 等只是本张地图标签，附实际 role 与采样时唯一的短 literal；重复或 relay 包装优先选择正文，更长 prefix 或 middle/end；无唯一短文本时明确标注。

每个 range 位于保护边界之间的同一 section，段内可任意细选，地图不规定压缩范围。B 标签和保护线索用于辨认不可选边界；端点从段内实际消息原文选择。pre-step 尚未落档的新输入／current entering Step 不在地图且不可选；工具跨度自动扩展后仍可能触保护，实际校验为准。

整条提醒及包装沿用 reminderMaxTokens/Bytes。预算不足时优先保留任务承载组，按剩余空间列出其他组；未列部分明确给出组数／节点数，不能据此认定区段无保护。核心行动文字及遗漏说明也放不下时，生成失败并报告实际计量与上限，不消耗提醒资格。每个启用路由指定 `provider`、`model`、`nudgeAtTokens`（S）和 `resetBelowTokens`（R），满足 `0 <= R < S < H`；H 是原生自动压缩线。独立提前提醒在每段持续高压只发送一次，实时计量低于 R 才复位；恢复时保留已落档提醒状态。提醒不额外发起模型请求，不改变原生兜底。

## 开发文档

- [行为核对](<docs/review-guide.md>)：字面定位、生命周期及源码验证方法。
- [成品构建与发布](<docs/delivery.md>)：打包、隔离安装、正式解析与 Loader 验证。
- [原文字面锚点设计](<docs/adr/0003-text-anchored-compaction.md>)：定位语义与取舍。
- [提交生命周期](<docs/adr/0001-active-compaction-submission.md>)与[压力提醒](<docs/adr/0002-pressure-notices.md>)：保护、事务、清理、计量和去重规则。
- [Query 同步只读采样](<../deepseek-harness/docs/subsystems/session-query.zh.md#synchronous-session-sampling>)。

跨仓库链接按并列工作区布局解析。
