# 项目协作提示词

## npm 发布

用户说“发布 npm”时，按项目现有 GitHub Actions 发布流程执行，不在本机直接运行 `npm publish`：

1. 完成必要检查后，将发布所需改动提交到当前分支并推送 GitHub；不得提交无关文件或凭证。
2. 等待约 3 分钟，让 GitHub Actions 完成构建与发布。
3. 查询 npm 官方 registry，核对当前包的版本、包状态和关键内容是否符合预期；同时检查 GitHub Actions 是否成功。
4. 若 Actions 失败、等待后包尚未发布或 npm 包内容不对，如实报告并停止，不重复发布或绕过 Actions。

以仓库中的 `.github/workflows/publish.yml` 和发布脚本为准；流程或凭证异常时先说明阻塞原因。
