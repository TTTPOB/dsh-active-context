## 分支与发布

- 长期发布分支为 `master`，位于 TTTPOB remote `origin`（github.com/TTTPOB/dsh-active-context）；本地长期分支必须跟踪 `origin/master`，不跟踪第三方上游。
- 开发和测试使用独立分支或 worktree。
- 发布前先合并到长期分支并 push，等待分支 CI（`.github/workflows/ci.yml`）通过。
- 仅从长期分支上的提交，通过 GitHub Actions Release workflow（`.github/workflows/release.yml`）发布；tag 和 Release 资产不可变，不上传本地构建。
- 本机约 13 GB 内存，本地只跑本仓库相关的 scoped 检查；重型全仓检查交给 CI。
