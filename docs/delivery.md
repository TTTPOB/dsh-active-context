# ACP 构建、成品验收与发布

本指南验证离开源码树的 ACP 成品。需要 Node.js 24、pnpm 11.24.0 和网络；依赖使用用户级 store 与默认 cache。源码行为验收另见[验收指南](<review-guide.md#源码验收复跑>)。

## 构建与打包

```sh
pnpm install --frozen-lockfile --ignore-workspace --config.auto-install-peers=false --config.enable-global-virtual-store=false
pnpm --config.verify-deps-before-run=false pack --pack-destination dist/release
```

`prepack` 执行严格 TypeScript 构建，产物包含 JavaScript 与声明文件。开发依赖显式安装构建所需 peers；正式消费 profile 只安装 ACP 和 session-tools，由 Host 提供 Cordis／DSH 服务 peers。

## 干净成品验收

在仓库根目录执行：

```sh
node tests/delivery/run.mjs \
  --acp "$PWD/dist/release/dsh-active-context-0.1.0.tgz" \
  --query "$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).devDependencies["@deepseek-ai/dsh-session-query"]')" \
  --map "$(node -p 'JSON.parse(require("fs").readFileSync("package.json")).devDependencies["dsh-session-tools"]')"
```

三个参数接受实际 tarball 路径或已核对的 Release URL。本地 tarball 只代表本地测试来源，不能代替正式依赖清单的 Release URL。

[入口](<../tests/delivery/run.mjs>)正规安装独立 DSH CLI `0.1.7-rc.2`；Host 根显式提供 app-boot、Tools、AgentLoop、Persistence 与 Basic 公开 peer 声明所需的框架和服务包，版本组合由入口声明；以 overrides 选择 Session fork1、Query fork4 和 SQLite fork6。另建只含 ACP `0.1.0` 与 session-tools `0.2.0` 的 profile，关闭自动安装 peers 和 global virtual store。Host 自有 workspace 允许明确的 URL overrides，并明确授权 CLI 依赖的安装构建脚本。它检查 profile lock 中没有 Cordis／DSH 服务包，再调用[生产解析与行为验收](<../tests/delivery/verify.mjs>)：

1. 通过公开 `createRuntimeResolution`／`PluginPackages` 与生产 `boot`／Loader 加载真实包名；检查服务 peer 的 Host 身份，Schemastery 检查同版本及 Host schema 校验。
2. 经真实 `session_context_map` executor 取得地图，由脚本化外部模型在真实 Loop 提交两个非相邻区间；检查中间约束、尾到头提交、下一请求工具对清理、最终回答及 Session replay。
3. 卸载 ACP 后检查 provider 与 `context_compress` 注册撤销。

兼容检查按包的实际 manifest 报告原始 peer 拒绝。本测试只为入口中明确列出的精确组合写入隔离 profile 的 test-local grant；真实 profile 的兼容授权属于正式部署流程。

所有测试资源在 `finally` 中清理；测试不启动 WebHost，不访问真实 profile、installation、sessions 或 storages。该入口使用确定性模型和受控服务组合；整份日用配置及真实模型质量评测使用各自的运行流程。

## 接入 dsh-config

沿用配置仓库的[既有成品测试入口](<../../dsh-config/docs/testing.md>)。在私有机器参数的 `deployment.smoke` 声明 `ownsInstallation: true`，`cwd` 为本仓库绝对路径；`argv` 使用 `node tests/delivery/run.mjs`，三个 source 参数分别使用 `{tarball:dsh-active-context}`、`{tarball:@deepseek-ai/dsh-session-query}` 与 `{tarball:dsh-session-tools}`。然后运行 `dsh-config test --machine ... --tarball 包名=/absolute/file.tgz`，传入三个成品。

入口消费配置侧复制的 tarball，自行拥有安装布局并自动清理。配置侧报告的 `renderedConfigurationVerified: false` 保持不变；正式两机目标另行 render/check 和 update 预览，不执行 apply。

## 发布

[Release workflow](<../.github/workflows/release.yml>)消费冻结的开发 lock，构建和 pack 后执行上述干净成品验收，成功才创建 Release。它通过 `v<package version>` tag 或显式 workflow dispatch 发布已有源码 tag；不需要并列 Harness checkout，也不在 CI 调用依赖该布局的源码测试入口。

发布先准备 Query fork4 和 session-tools `0.2.0` 的真实 Release 资产，再将其 URL 写入开发依赖并由 pnpm 更新 lock。ACP 发布后把实际资产 URL 交给 dsh-config 清单维护者。发布、预览、真实安装和原 Host 启用分别验收。

本文跨仓库本地链接用于并列工作区；独立克隆可在 [dsh-config](https://github.com/TTTPOB/dsh-config) 与 [Harness](https://github.com/TTTPOB/deepseek-harness) 仓库查阅对应指南。
