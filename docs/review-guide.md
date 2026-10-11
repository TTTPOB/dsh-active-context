# ACP 行为核对与验收指南

本文供实现者和独立审查者核对 ACP 的行为与证据。日常使用流程与交付范围见 [README](<../README.md>)；各 ADR 分别记录实施和验收情况。

## 职责与设计入口

| 组件 | 负责的行为 | 设计记录 |
|---|---|---|
| session-tools | 当前 Surface 的有界概览、节点窗口、定位与同源计量 | [地图 ADR 0004](<../../dsh-session-tools/docs/adr/0004-context-map-and-metering.md>) |
| Query | live/cold 源解析、同步只读采样、读取上界及租约 | [同步采样决策](<../../deepseek-harness/.agents/notes/implemented/architecture/2026-10-10-session-query-synchronous-capture.zh.md>) |
| ACP 提交 | 目标保护、多区间执行、独立调用准入、最终结算及工具对清理 | [ADR 0001](<adr/0001-active-compaction-submission.md>) |
| ACP 提醒 | 原生压力处理后的提醒、阈值、整条消息预算及高压期去重 | [ADR 0002](<adr/0002-pressure-notices.md>) |

Query 按所属仓库维护英文、中文及一致性记录；其他 ADR 使用所属树外项目的中文格式。字段与预算在各自权威记录维护，验收证据进入相应记录或现有测试入口。

## 核对使用行为

### 1. 地图与回读

`session_context_map` 每次采样当前 Surface，返回有界概览和当前节点窗口。窗口查询重新采样；anchor 已被替换时要求重新定位。节点位置按 Surface 顺序解释，不能按 seq 大小推断连续区间。

地图返回的 `snapshot_ref` 包含 `session_id`、包含上界事件的 `read_seq` 和诊断用 `map_id`。回读节点时使用节点自己的 `seq/read_seq`，而不是快照读取上界。预览来自 Session 消息解释，节点估价来自 token-meter 的原事件折叠；二者按 seq 对齐，但所依据的文本可能不同。

`getContextMap` 在采样前检查调用方 scope，并在同步回调中重新核对。纯函数 `buildContextMap` 只构造 DTO，授权及同次采样由调用方负责。地图不保存跨调用快照缓存；Query 的 prepared Session 缓存仍按源版本和准备模式管理。首次 cold 准备和计量可能有全量成本，缩小窗口主要减少输出。

### 2. 摘要提交与失败处理

核对一次独立 native/both `context_compress` 调用能提交至少两个非相邻区间，并保留中间内容。整体预检应先于任何事务，涵盖目标存活、工具配对、保护规则、摘要预算和调用身份。

逐项执行从 Surface 尾部向前进行；目标发生变化或首个执行失败时停止，已提交项不回滚。部分成功、取消及 replacement 写入后的错误必须保留真实提交事实。模型据结果刷新地图，只重试失败或未执行项。

保护范围与摘要保留要求见 ADR 0001。最近任务输入的保护包括承载该输入的存活 checkpoint；原生压缩不能使该保护丢失。宿主检查结构和保护规则，摘要能否支持后续任务需要连续工作评测。

### 3. 准入、结算与清理

压缩调用必须独立于其他工具和任务正文。混合批次、重复调用、缺失身份或 PTC 调用应在压缩事务前拒绝；普通兄弟工具仍按原生调度执行。

工具 body 完成不等于最终成功。只有全批成功、最终落档结果正常，且调用与结果仍是精确相邻存活节点时，下一 Step 才清理工具对。错误、部分成功、取消或匹配失败保留原消息。清理前重启不恢复内存候选；已写入的替换由 Log 回放。

### 4. 提前提醒与原生兜底

每次正常请求依次执行：成功工具对清理 → 原生压力处理 → ACP 重测 → 本次提醒。提醒不能额外唤起被拒绝、取消或跳过的请求。

提前提醒只对显式配置的路由启用，默认 `pressureRoutes: []`。启用路由需核对容量、输出预留和原生策略，满足 `R < S < H`。整条提醒预算包含消息包装、粗地图和指引；超预算依次缩短预览、减少区间、保留短提醒。

每段持续高压只提醒一次；实时计量 `T < R` 后恢复资格。reload/resume/HMR 后，当前低于 R 直接复位，否则在当前 Session 的原始 Log 中通过 `eventAt` 一次扫描恢复已提醒状态。正常步骤使用内存状态；不写 reset 事件，不重建历史压力。降压后再升高、第二条提醒落档前恰好重启时，可能沿用旧的已提醒状态，直到再次测得 `T < R`。

## 源码验收复跑

保持当前工作区的并列仓库布局：ACP、session-tools 和 Harness 源码位于同一父目录，Harness 已有 Vitest、TypeScript、测试依赖及 vendor 声明产物。在 ACP 仓库执行：

```sh
node tests/acceptance/run.mjs
node tests/acceptance/typecheck.mjs
# 或依次执行严格检查和测试：
pnpm --config.verify-deps-before-run=false check
```

[测试入口](<../tests/acceptance/run.mjs>)执行 ACP 测试与 Query capture 类型测试；[严格类型检查入口](<../tests/acceptance/typecheck.mjs>)检查 ACP、地图源码及测试，不过滤诊断。独立统一验收已通过 14 个测试文件、56 项测试及 33 个 ACP/地图源码与测试入口的严格类型检查（TypeScript 6.0.3，零诊断过滤）。以上通过源码路径别名运行，交付及尚未验证范围见 [README](<../README.md#交付与验证范围>)。

[录制回放场景](<../tests/acceptance/recorded-replay.spec.ts>)复用既有 `installLlmReplay` 与 `normalizeSessionSnapshots`：首次真实 Loader/Loop 执行双区间压缩，按原生 JSONL 格式记录；第二个全新 Loader/Loop 消费全部 5 条录制流，fallback adapter 调用为 0，两次完整规范化 Log 一致。场景检查摘要、未选内容、工具对清理、下一请求及最终回答；对应现有 replay/snapshot helper 的覆盖范围。

## 验收与证据

1. **Query 与地图：** 验证 live/cold、store/canonical 差异、cut 与 meter revision、只读类型与 DTO 所有权、当前窗口、失效 anchor、计量依据、scope 和完整输出预算。
2. **提交与清理：** 验证双非相邻区间、保护与工具配对、目标变化、部分成功、取消、提交后错误、准入、最终结算、两次 append 中断及 replay。
3. **真实组合：** 用现有 testkit、Mock LLM、keyless session snapshot 和真实 Loader 验证工具注册、唯一 provider、公开导入、peer 单例与清理→原生压力→提醒时序。源码测试不能代替打包后导入和隔离安装验证。
4. **预算与任务质量：** 用主用路由及本机会话校准地图、提醒、回读和摘要开销；压缩后继续完成修改和验证，检查关键约束与未解决项是否保留。成本结论需实际 input/output usage、额外请求、缓存和延迟对照。

前三项对应各设计记录的验收要求；第四项决定预算是否适合日常工作及压缩是否真正有收益。尚未执行或缺少证据的项目保持待验，不以文档状态、目录存在或版本号代替验证。
