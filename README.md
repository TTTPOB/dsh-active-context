# dsh-active-context

ACP（Active Context Pruning，模型主动裁剪上下文）是树外 Cordis 插件。工作模型选择已处理的历史、提交自己的摘要；插件验证目标和保护规则后，复用原生压缩事务替换所选区间。原始 Log 保留，供后续回读。

## 使用流程

1. 用 `session_context_map` 查看当前 Surface 的概览和节点窗口，按需通过 `session_event_read` 回读原事件。
2. 从同一次地图的 `snapshot_ref` 选择一个或多个非相邻区间，为每个区间写摘要。保留结论、精确名称与路径、修改和验证证据、失败原因、未解决项、约束及回读入口。
3. 在一条独立 assistant 响应中直接调用一次 `context_compress`，提交 `snapshot_ref` 和 `regions`。使用 native 或 both 通道；该响应只包含这一次工具调用及可选 reasoning，不带其他工具或任务正文，也不经 run_code/PTC 调用。
4. 查看逐项结果。执行从 Surface 尾部向前进行，首个失败即停止，已提交项保留。部分成功或失败后刷新地图，只重新选择失败或未执行项。

当前 system/developer、当前 Step、最近任务输入及存活的 `form:instructions` 受保护。全批成功且最终工具结果正常落档后，插件在下一 Step 的原生压力检查前，用短确认替换相邻的调用与结果消息。错误、部分成功、取消及清理前中断保留原工具对。

## 配置与运行条件

- ACP 替换唯一 `compaction` provider；使用时须禁用原 Basic provider。原生自动压缩、pruner 和 overflow 处理仍由插件内的 Basic 实现执行。
- 配置分为 `acp` 和 `basic`：前者控制批次、摘要、结果、短确认和提醒预算，后者控制原生压力策略。
- `acp.pressureRoutes` 默认为 `[]`，提前提醒默认禁用。仅显式配置的 provider/model 路由可提醒，阈值须满足 `resetBelowTokens < nudgeAtTokens < 原生自动压缩线`。
- 依赖 Query 的 `captureSession` 和 session-tools 的公开 `context-map` 库。地图负责采样与定位，ACP 负责保护、提交及清理。

## 交付与验证范围

本轮版本为 Query `0.1.7-rc.2-fork4`、session-tools `0.2.0`、ACP `0.1.0`，仅用于本地源码开发，尚未发布。源码和测试文件已经存在；完整验收、真实安装与成本效果仍待确认，不能据此视为当前 Host 已启用。ADR 状态与实施记录在独立验收后更新。

[行为核对与验收指南](<docs/review-guide.md>)列出职责分工、验证要求和证据归属。详细设计：

- [通用 Surface 地图与计量](<../dsh-session-tools/docs/adr/0004-context-map-and-metering.md>)
- [Query 同步只读采样](<../deepseek-harness/.agents/notes/proposed/architecture/2026-10-10-session-query-synchronous-capture.zh.md>)
- [主动压缩提交与生命周期](<docs/adr/0001-active-compaction-submission.md>)
- [提前压力提醒与原生兜底](<docs/adr/0002-pressure-notices.md>)

跨仓库链接按当前工作区的并列目录布局解析。
