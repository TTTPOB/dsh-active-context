# dsh-active-context

ACP（Active Context Pruning，模型主动裁剪上下文）是树外 Cordis 插件。工作模型选择已处理的历史、提交自己的摘要；插件验证目标和保护规则后，复用原生压缩事务替换所选完整节点区间。原始 Log 保留，供后续回读。

## 使用流程

1. 为一个或多个非相邻区间选择两个独特原文端点，按需通过历史工具回读。每个端点包含 `text` 和可选的实际消息 `role`。
2. 为每个区间写非空 `summary`，保留结论、精确名称与路径、修改和验证证据、失败原因、未解决项、约束、不确定性及回读入口。
3. 在一条独立 assistant 响应中直接调用一次 `context_compress`，提交 `regions`。使用 native 或 both；该响应只包含这次工具调用及可选 reasoning，不带其他工具或任务正文，也不经 run_code/PTC 调用。
4. 查看逐项结果。`input_index` 从零开始对应输入，`execution_order` 给出实际尝试顺序。执行从 Surface 尾部向前进行，首个失败即停止，已提交项保留。部分成功或失败后，用当时当前正文重新选择失败或未执行项。

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

每个 `range` 恰有两个端点，按当前 Surface 位置指定起点和终点，包含两端的完整节点及中间全部节点；两端可以定位同一节点。每个端点独立匹配整个当前调用会话的派生消息 text block，使用大小写敏感的 literal substring，不 trim、不规范化、不跨 block 拼接。端点必须非空，空白本身也是字面文本。同一节点内多次或多 block 命中只算一个候选；不同节点重复则拒绝，可换更独特原文或加 `role`。`role` 只限定该端点，不过滤区间内部节点。

匹配不搜索 reasoning、工具参数、附件占位、provider wrapper 或原始 Log，也不提供 regex、occurrence、模糊匹配或 ID 选区。正文已被替换时，只能命中当前摘要节点，不代表旧原节点仍存活。任一端点缺失或歧义、倒序、区间重叠或相邻、保护或工具配对不满足，都会在写入前拒绝全批。

当前 system/developer、当前 Step、最近任务输入（包括承载该输入的存活 checkpoint）及存活的 `form:instructions` 受保护。选区不会自动扩界。全批成功且最终工具结果正常落档后，插件在下一 Step 的原生压力检查前，用短确认替换相邻调用与结果节点；错误、部分成功、取消及清理前中断保留原工具对。

## 配置与运行条件

ACP 替换唯一 `compaction` provider；使用时须禁用原 Basic provider。原生自动压缩、pruner 和 overflow 处理仍由插件内的 Basic 实现执行。依赖 Query `captureSession` 和 tokenMeter，不需要 session-tools；普通历史工具可独立启用。

配置分为 `acp` 和 `basic`：前者控制提交与提醒预算，后者控制原生压力策略。ACP 默认值：

| 配置 | 默认值 | 用途 |
|---|---:|---|
| `maxRegions` | 4 | 每批区间上限，至少允许 2 |
| `summaryMaxTokens` / `summaryMaxBytes` | 8000 / 32000 | 全批摘要总预算 |
| `resultMaxBytes` | 16000 | 工具结果预算 |
| `confirmationMaxTokens` / `confirmationMaxBytes` / `confirmationMaxIds` | 256 / 2048 / 4 | 成功工具对清理后的短确认预算 |
| `reminderMaxTokens` / `reminderMaxBytes` | 1200 / 6000 | 整条压力提醒及消息包装预算 |
| `taskSourceKinds` | `user`, `agent-message`, `goal`, `schedule` | 最新任务来源；notice 不作为任务，agent-message 只认 relay |
| `pressureRoutes` | `[]` | 仅显式路由启用提前提醒 |

提醒包含压力、计量依据和简短行动建议，不附候选区间。每个启用路由指定 `provider`、`model`、`nudgeAtTokens`（S）和 `resetBelowTokens`（R），满足 `0 <= R < S < H`；H 是原生自动压缩线。每段持续高压只提醒一次，实时计量低于 R 才复位；恢复时保留已落档提醒状态。提醒不额外发起模型请求，不改变原生兜底。

## 开发文档

- [行为核对](<docs/review-guide.md>)：字面定位、生命周期及源码验证方法。
- [成品构建与发布](<docs/delivery.md>)：打包、隔离安装、正式解析与 Loader 验证。
- [原文字面锚点设计](<docs/adr/0003-text-anchored-compaction.md>)：定位语义与取舍。
- [提交生命周期](<docs/adr/0001-active-compaction-submission.md>)与[压力提醒](<docs/adr/0002-pressure-notices.md>)：未被新 ADR 替代的保护、事务、计量和去重规则。
- [Query 同步只读采样](<../deepseek-harness/docs/subsystems/session-query.zh.md#synchronous-session-sampling>)。

跨仓库链接按并列工作区布局解析。
