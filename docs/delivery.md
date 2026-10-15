# ACP 构建、成品验证与发布

本指南验证离开源码树的 ACP 成品。需要 Node.js 24、pnpm 11.24.0 和网络；依赖使用用户级 store 与默认 cache。[源码验证](<review-guide.md#源码验证入口>)与正式成品解析分开运行。

## 构建与打包

在允许安装依赖的开发副本中执行：

```sh
pnpm --config.verify-deps-before-run=false install --frozen-lockfile --ignore-workspace --config.auto-install-peers=false --config.enable-global-virtual-store=false
pnpm --config.verify-deps-before-run=false pack --pack-destination dist/release
```

`prepack` 执行严格 TypeScript 构建，产物包含 JavaScript 与声明文件。开发依赖显式安装构建所需 peers；正式消费 profile 只需安装 ACP，由 Host 提供 Cordis／DSH 服务 peers。ACP 不依赖 session-tools 的工具或公开库。

## 隔离成品验证

在 ACP 根执行：

```sh
node tests/delivery/run.mjs \
  --acp "$PWD/dist/release/dsh-active-context-0.4.3.tgz" \
  --query "$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).devDependencies["@deepseek-ai/dsh-session-query"]')"
```

两个参数接受实际 tarball 路径或已核对的 Release URL。本地 tarball 只代表隔离测试来源，不能代替正式依赖清单的 Release URL。嵌套 pnpm 调用设置 `npm_config_verify_deps_before_run=false`。

[安装入口](<../tests/delivery/run.mjs>)正规安装独立 DSH CLI；Host 根显式提供 Tools、AgentLoop、Persistence 与 Basic 需要的框架和服务 peers，以 overrides 选择 capture-capable Session／Query 及 SQLite。另建只含 ACP 的 profile，关闭自动安装 peers 和 global virtual store。它检查 profile lock 未引入 Cordis／DSH 服务副本，再运行[生产解析与行为验证](<../tests/delivery/verify.mjs>)：

1. 使用公开 `createRuntimeResolution`／`PluginPackages` 与生产 `boot`／Loader 加载真实包名，检查服务 peer 的 Host 身份、同版本 Schemastery 及 schema 校验。
2. 由脚本化模型在真实 Loop 直接提交原文端点与摘要，验证双相邻完整区间、独立摘要、保留约束和尾到头事务、下一请求工具对清理、最终回答和 Session replay；另一真实 Agent 验证 relay 正文保护地图、ACP 展示不作端点、保护 split 建议按原样重提成功，以及替换记录提示仍高压而不新增提前提醒。
3. 卸载 ACP 后检查 provider 与工具注册撤销。

兼容检查按实际 manifest 报告 peer 拒绝；测试只为入口中明确列出的精确组合写入隔离 profile 的 test-local grant。真实 profile 的授权属于正式部署流程。

测试不启动 WebHost，不访问真实 profile、installation、sessions 或 storages。测试资源在 `finally` 中清理；默认暂存位于仓库 ignored `.scratch/text-anchors/delivery/`，配置侧可传入 `DSH_CONFIG_TEST_ROOT`。

## 配置侧接入

沿用 dsh-config 的[成品测试入口](<../../dsh-config/docs/testing.md>)。在私有机器参数的 `deployment.smoke` 声明 `ownsInstallation: true`、ACP 根目录 `cwd`，`argv` 使用 `node tests/delivery/run.mjs --acp {tarball:dsh-active-context} --query {tarball:@deepseek-ai/dsh-session-query}`。用 `dsh-config test --machine ... --tarball 包名=/absolute/file.tgz` 传入两个成品。

入口消费配置侧复制的 tarball，自行拥有安装布局并自动清理。配置侧 `renderedConfigurationVerified: false` 表示没有验证整份日用配置；正式目标另行 check 和 update 预览，apply 需要单独授权。

## 发布

[Release workflow](<../.github/workflows/release.yml>)消费冻结开发 lock，构建、pack 并完成隔离成品验证后，才创建不可变 Release。它发布已有源码 tag，不需要并列 Harness checkout。

公开输入和导出变动需要同步更新实际消费者。发布必须选择新的不可变包版本和资产，不覆盖既有同版本 Release；仅在资产实际发布后，才由 dsh-config 清单维护者选择精确 URL。本地构建、发布、安装及 Host 激活分别验证，均不由源码检查替代。

跨仓库链接适用于并列工作区；独立克隆可在 [dsh-config](https://github.com/TTTPOB/dsh-config) 与 [Harness](https://github.com/TTTPOB/deepseek-harness) 仓库查阅对应指南。
