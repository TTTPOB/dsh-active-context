# ACP 设计文档入口

ACP（Active Context Pruning，模型主动裁剪上下文）采用树外 Cordis 插件。本仓库当前只提交设计文档，尚未实现或创建 Node 项目。请从[逐步审阅指南](docs/review-guide.md)开始。

1. [通用 Surface 地图与计量](../dsh-session-tools/docs/adr/0004-context-map-and-metering.md)：保留 Accepted，尚未实现。
2. [Query 同步只读采样](../deepseek-harness/.agents/notes/proposed/architecture/2026-10-10-session-query-synchronous-capture.zh.md)：Agent Note 保持 proposed。
3. [主动压缩提交与生命周期](docs/adr/0001-active-compaction-submission.md)：保持 Proposed。
4. [提前压力提醒与原生兜底](docs/adr/0002-pressure-notices.md)：保持 Proposed。

对应实现完成并验收后，再更新其状态；Query 使用 Agent Note 的 implemented 生命周期。跨仓库链接按当前工作区的并列目录布局解析。
