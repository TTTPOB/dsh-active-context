# ACP 构建与成品验证

需要 Node.js 24、pnpm 11.28.5 与网络。依赖使用用户级 store 和默认 cache；源码检查入口见[行为核对](review-guide.md#源码验证入口)。ACP 的准确版本与 peers 以 package.json 为准，Session／Query 需要配套 rc.1 fork。

## 本地构建与打包

在开发副本中准备真实的 Session／Query `0.2.1-rc.1-fork1` tarball。用被忽略的 `pnpm-workspace.yaml` overrides 选择它们，将安装 lockfile 放入 `.scratch/local-lock`；不要提交本机 file: 路径或猜测发布 URL。示例 overrides：

```yaml
packages: ['.']
overrides:
  '@deepseek-ai/dsh-session': file:/absolute/path/deepseek-ai-dsh-session-0.2.1-rc.1-fork1.tgz
  '@deepseek-ai/dsh-session-query': file:/absolute/path/deepseek-ai-dsh-session-query-0.2.1-rc.1-fork1.tgz
blockExoticSubdeps: false
```

```sh
NODE_OPTIONS=--max-old-space-size=3072 pnpm install --ignore-scripts --lockfile-dir .scratch/local-lock
NODE_OPTIONS=--max-old-space-size=3072 pnpm --config.verify-deps-before-run=false build
NODE_OPTIONS=--max-old-space-size=3072 pnpm --config.verify-deps-before-run=false pack --pack-destination dist/release
```

`prepack` 运行严格 TypeScript 构建，成品包含 JavaScript、声明文件与文档。正式 profile 只安装 ACP，由 Host 提供 Cordis／DSH 服务 peers。ACP 不依赖 session-tools。

## 隔离安装验证

在 ACP 根显式传入四个真实资产路径；参数也接受已核对的 HTTPS Release URL：

```sh
NODE_OPTIONS=--max-old-space-size=3072 node tests/delivery/run.mjs \
  --acp "$PWD/dist/release/dsh-active-context-0.5.0.tgz" \
  --session /absolute/path/deepseek-ai-dsh-session-0.2.1-rc.1-fork1.tgz \
  --query /absolute/path/deepseek-ai-dsh-session-query-0.2.1-rc.1-fork1.tgz \
  --sqlite /absolute/path/deepseek-ai-dsh-session-query-sqlite-0.2.1-rc.1-fork1.tgz
```

入口在 ignored `.scratch/text-anchors/delivery/` 下安装独立 DSH 依赖根与只含 ACP 的 profile，关闭 profile 自动安装 peers。测试使用生产 `createRuntimeResolution`／`PluginPackages` 与进程内 Loader，核对服务 peer 身份、包版本、built entry、schema、相邻区间压缩、来源范围、清理、提醒、最终回答、replay 和卸载。源码 PTC 回归另验证规范程序、部分失败、取消、策略覆盖与成功 root pair 清理。

入口不启动 Host，也不访问真实 profile、installation 或 Harness 状态；资源在 finally 清理。`DSH_CONFIG_TEST_ROOT` 可指定验证拥有的暂存目录；`renderedConfigurationVerified: false` 表示没有验证整份日用配置。兼容检查需要的 test-local grants 仅作用于隔离 profile，不代替真实部署授权。

## 发布前提

当前 fork 资产尚未发布，开发 manifest 保持精确版本且不带本机路径。发布前必须先固定真实、不可变的 fork 来源并由 pnpm 生成可复现的发布 lockfile，再运行全部成品检查。Release workflow 的冻结安装在缺失 lockfile 时会明确停止；人工触发时还须提供已核对的 Session／Query／SQLite 资产 URL。

本地构建、资产发布、正式配置安装和 Host 激活各自验证。新 URL 只在资产发布并核实后填写；不可复用或覆盖旧版本产物。此次升级不执行发布或激活。
