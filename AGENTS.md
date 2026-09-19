# 项目协作提示词

## npm 发布

用户说“发布 npm”时，在本机用 `.npmrc` 里的 token 直接发布，不依赖 GitHub Actions：

1. 必要时改 `package.json` 的 `version`，先跑 `npm run check && npm test`。
2. 提交并推送当前分支到 GitHub；不得提交无关文件或凭证。
3. 发布：`npm publish --access public --registry=https://registry.npmjs.org`。
4. 等约 1 分钟，用 `npm view @each1024/pi-mini-mode version dist-tags time --json` 核对版本、latest 与包内容；失败或内容不对时如实报告并停止，不重复发布。

凭证放在项目根 `.npmrc`（`//registry.npmjs.org/:_authToken`，已在 `.gitignore`），也可用全局 `~/.npmrc`；**不得把 token 写进任何会被提交的文件**。

`.github/workflows/publish.yml` 只保留 `workflow_dispatch` 手动触发，作为本机不可用时的备份，避免与上一步重复发布同一版本。
