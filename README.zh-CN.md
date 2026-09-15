# Mini Lens for Pi（中文）

[English](README.md)

<p align="center">
  <img src="assets/mini-lens-hero.png" alt="Mini Lens：显示模型、令牌、缓存、费用、上下文和生成速度的紧凑页脚" width="100%">
</p>

适用于 [Pi](https://pi.dev) 的紧凑、可配置页脚。模型、用量、费用估算、上下文使用率和生成速度，一眼即可查看。

## 安装

```bash
pi install npm:@each1024/pi-mini-mode
```

在 Pi 中运行 `/reload`。需要 **Pi ≥ 0.84.0**。

也可以直接从 GitHub 安装：

```bash
pi install git:github.com/eachann1024/pi-mini-mode
```

## 极简输出

在 `/mini-lens-settings` 中可以找到 **Lens**、独立的 **Collapse replies（折叠回复）** 和 **Minimal output（极简输出）** 设置。折叠回复默认关闭；关闭时，极简输出选项也会禁用。

- `/mini-lens-minimal on` 显示带主题色背景的用户 Markdown、无背景的过程摘要，以及没有标题和额外背景的最终回复。
- 每轮使用一棵共享树，显示最新 **10 条摘要**，包括思考、工具调用、流式工具输出和技能读取。按 `Ctrl+O` 展开完整 Markdown 过程，再按一次收起。
- Agent/subagent 调用会按时间顺序与工具、技能共用同一棵树；展开后可查看任务和 Markdown 输出。
- `/mini-lens-history` 可浏览完整过程记录，每次显示 5 条。
- 最终 Markdown 会随着文本事件流式显示；失败和中断会明确标记。
- `/reload` 会重新挂载 transcript，也会包含原生模式中产生的历史记录。
- `/mini-lens-minimal off` 恢复 Pi 默认的对话历史显示。

极简模式使用私有的 Pi 0.85.x 布局适配器，不会修改 Pi 安装目录。未知布局会拒绝启用并保留原生输出。升级 Pi 后请重新检查兼容性；如果其他扩展也替换 transcript，可能产生冲突。

## 页脚指标

默认显示：

- 模型与思考级别
- 会话令牌总数
- 缓存令牌与命中率
- 会话费用估算
- 上下文用量与进度条
- 最新生成速度

运行以下命令即可配置显示字段，修改立即生效，并会按照当前 Pi 主题预览：

```text
/mini-lens-settings
```

页脚会跟随 Pi 主题并适配窄终端。只有页脚会变化，Pi 内置的工具和思考视图保持不变。

## 配置

设置保存在 Pi 的 agent 目录中，通常是 `~/.pi/agent/mini-lens.json`。文件缺失或格式错误时会安全回退到默认设置。

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `mini-lens-model-show` | `true` | 显示模型 ID |
| `mini-lens-thinking-show` | `true` | 显示思考级别 |
| `mini-lens-ch-show` | `true` | 显示会话缓存命中率（`CH`） |
| `mini-lens-session-tokens-show` | `true` | 显示会话累计令牌（`Total`） |
| `mini-lens-cache-tokens-show` | `true` | 显示缓存读取与写入令牌 |
| `mini-lens-cost-show` | `true` | 显示会话费用估算 |
| `mini-lens-context-show` | `true` | 显示上下文令牌和进度条 |
| `mini-lens-context-dots-show` | `false` | 使用点阵进度条 |
| `mini-lens-context-percent-show` | `true` | 显示上下文使用百分比 |
| `mini-lens-speed-show` | `true` | 显示最新生成速度 |
| `mini-lens-speed-unit-show` | `true` | 在速度后显示 `tok/s` |
| `mini-lens-minimal-show` | `false` | 折叠回复；关闭则使用 Pi 默认历史显示 |

生成速度只有在获得有效的输出令牌和耗时后才会显示，不会显示 `-- tok/s` 占位符。速度颜色遵循 Pi 主题：至少 30 tok/s 为成功色，10–29.9 tok/s 为警告色，低于 10 tok/s 为错误色。费用是基于已完成会话用量和配置费率的估算，并非服务商账单。

## 开发

```bash
pi remove npm:@each1024/pi-mini-mode && pi install /path/to/pi-mini-mode
npm run check
npm test
```

修改源码后，在已打开的 Pi 会话中运行 `/reload`。真实终端冒烟测试：

```bash
python3 test/minimal-pty.py
```

## 发布

推送到 `main` 后，GitHub Actions 会在通过 `npm ci`、`npm run check` 和 `npm test` 后自动发布到 npm。发布使用 npm Trusted Publisher、OIDC 和 provenance，无需 npm token。

---

[MIT License](LICENSE) · 为 [Pi](https://pi.dev) 打造
