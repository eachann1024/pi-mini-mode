<p>
  <img src="https://raw.githubusercontent.com/eachann1024/pi-mini-mode/main/assets/readme-cover.zh-CN.svg" alt="Pi Mini Mode — 少一点干扰，多一点专注。图片输入、可折叠对话、子代理、明暗主题与实时页脚。" width="100%">
</p>

[English](https://github.com/eachann1024/pi-mini-mode/blob/main/README.md) · [安装](#安装) · [功能](#功能) · [参考](#参考)

# Pi Mini Mode

**少一点干扰。多一点专注。**

为 [Pi](https://pi.dev) 的日常工作做一点精细的改进，不止于页脚。光标处预览图片，折叠长消息和过程详情，展开子代理工作，让重要的会话状态始终清晰。

<details>
<summary>查看完整界面</summary>

<img width="892" height="797" alt="Pi Mini Mode 完整界面" src="https://github.com/user-attachments/assets/8f7abdc8-646e-4ded-8009-b58d2833c1f4" />

</details>

## 安装

```bash
pi install npm:@each1024/pi-mini-mode
```

已打开的 Pi 会话中，运行 Pi 自带的 `/reload`。首次使用选择 **应用推荐配置**，设置内置主题和全屏模式，重启 Pi 后全屏才会生效。之后可用 `/pi-mini-mode-settings` 随时配置本扩展。项目设置和命令行参数可能覆盖全局设置。

**需要 Pi ≥ 0.84.0。** 输入增强和极简输出默认开启。极简模式使用私有 **Pi 0.85.x** 布局适配器，启用前请查看[兼容性](#兼容性)。

<details>
<summary>也可以从 GitHub 安装</summary>

```bash
pi install git:github.com/eachann1024/pi-mini-mode
```

</details>

## 功能

### 01 / 输入，更顺手

<img width="1092" height="764" alt="图片预览与紧凑标签" src="https://github.com/user-attachments/assets/2ea6d037-d3f0-423c-8588-17992a49d445" />

**图片，随光标浮现。** 编辑光标移入图片路径或紧凑标签，即可预览。全屏编辑器也支持悬停，按 `Esc` 关闭。

**收起路径，保留原图。** 输入框和消息中的图片路径收纳为带下划线的 `[image1]` 标签，提交时保留原始路径。使用终端的链接点击手势，即可通过系统默认应用打开原图或其他文件。

**技能，就在输入处。** 在输入起点或空白后键入 `/` 搜索技能，在当前光标处插入 `/skill:name`，提交时展开。URL 和文件路径中的斜杠保持原有行为。

使用 `Ctrl+V` 粘贴图片，Windows/WSL 使用 `Alt+V`。关闭输入增强不会关闭 Pi 原生剪贴板功能。

### 02 / 过程，更安静

在 `/pi-mini-mode-settings` 中开启 **极简输出**。

<img width="1092" height="764" alt="极简输出中的过程树" src="https://github.com/user-attachments/assets/eb8c88f6-84af-499e-b105-5395b4f02e66" />

- **长消息，自动折叠。** 全屏极简模式下，长用户消息默认保留前四个显示行。点击折叠控件展开全文。完整代码围栏保持完整。
- **子代理，清晰可查。** 点击子代理行，展开可用的活动记录与消息／最终输出。极简模式下，本扩展用 `Ctrl+S` 展开／收起已完成的子代理摘要；Pi 当前聚焦的选择器保留自己的快捷键。任务派发回执或工具调用返回，不等于后台任务已完成。
- **过程是一棵树，而非满屏输出。** 思考、工具与技能读取汇入同一棵时间顺序树，显示最新摘要，包括最新一条思考；`Ctrl+O` 展开／收起完整过程，新问题默认收起。
- **工具详情，按需展开。** 点击工具或思考条目的折叠控件，最新一条思考也可以展开。思考默认收起，进行中与结束后均只由手动操作展开或收起。工具详情展示保存的文本，不还原原生自定义渲染器或图片输出。
- **把空间留给答案。** 最终 Markdown 流式呈现，不添加额外标题或背景。失败和中断明确标记；折叠只改变显示，不删除原始会话消息。

在设置中关闭 **极简输出** 即恢复 Pi 原生历史。

<img width="1092" height="764" alt="展开后的过程详情" src="https://github.com/user-attachments/assets/53f5aa28-4b96-45db-b02e-0108aa9e68bc" />

### 03 / 状态，更清晰

**明暗，皆有章法。** 自带 `cc-light` 与 `cc-dark`，源自 [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions)，采用 MIT 许可。用户消息使用主题的用户背景色；Markdown、代码高亮、表格及支持的 Mermaid 图表适配明暗主题。不支持、不完整或过宽的图表保留源文本。

**重要指标，一行看清。** 模型与思考级别、会话令牌、缓存总量与命中率、费用估算、上下文用量与生成速度。在 `/pi-mini-mode-settings` 中选择显示字段，即时生效，页脚自动适配窄终端。

<details>
<summary>查看页脚设置截图与演示</summary>

[![已有的页脚设置截图](https://raw.githubusercontent.com/eachann1024/pi-mini-mode/main/assets/pi-mini-mode-settings.jpg)](https://raw.githubusercontent.com/eachann1024/pi-mini-mode/main/assets/pi-mini-mode-settings.jpg)

[观看页脚设置演示](https://github.com/user-attachments/assets/5f2f4816-45ed-4759-b035-d9ee59e8a763)

这份已有截图和录屏展示页脚配置，不代表新增图片、折叠与子代理功能的当前界面。设置预览使用示例数据。

</details>

## 兼容性

- **图片：** 预览依赖终端图片协议，不支持时显示提示。读取上限 **20 MB**，文件被清理后无法重新打开。点击手势由终端决定：macOS 通常使用 `Cmd+点击`，Windows/Linux 通常使用 `Ctrl+点击`；Ghostty 全屏可能需要 `Shift+Cmd` / `Shift+Ctrl`。Pi 全屏也支持直接点击链接。参见 [Pi 终端设置](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/terminal-setup.md)。
- **极简输出：** 使用私有 Pi 0.85.x 布局适配器，不修改 Pi 安装目录。未知布局会拒绝启用并保留原生输出；升级 Pi 后需重新检查，其他替换 transcript 的扩展可能冲突。
- **子代理：** pi-subagents 小组件适配仅在极简模式启用，关闭后恢复原状，未知格式原样交给原生处理。可用详情取决于集成提供的状态／输出数据，不是完整子代理会话查看器。
- **历史：** `/reload` 会重新挂载 transcript，包含原生模式中产生的历史。空进度事件不覆盖已有内容；无输出的工具显示等待时间。旧的极简输出细项不再单独过滤内容。
- **指标：** 费用是估算，不是 provider 账单。计算方式见下方参考。

## 参考

<details>
<summary><strong>首次使用与配置</strong></summary>

首次进入交互式 TUI 会话时，Pi Mini Mode 显示设置预览。「仅显示分支」「缓存 token」「MCP」默认关闭；「仅显示分支」与「项目与分支」互斥。之后可用 `/pi-mini-mode-settings` 再改。

以下示例开启了可选的 Cached 和 MCP 字段：

```text
deepseek-v4-flash  high  Total 45K  Cached 25K  CH 40.0%  $0.012  ◇ MCP 3  500/1.0M  ⣿⣀⣀⣀⣀⣀⣀⣀⣀⣀  1%  120 tok/s
```

首次设置会提供 **Keep defaults（保留默认值）**、**Configure now（立即配置）** 和 **Apply recommended setup（应用推荐配置）**。保留默认值会保存默认字段选择、保持极简输出开启，并且不再显示首次设置提示；立即配置会直接打开同一设置列表。应用推荐配置会让你选择内置的 `cc-dark` 或 `cc-light` 主题，通过 Pi 官方设置 API 保存该主题和全局 `tuiMode=fullscreen`，立即应用主题，并提示重启 Pi（全屏渲染器在启动时决定）。项目设置和命令行参数可能覆盖全局设置。按 Esc／取消不会完成首次设置，下次交互式会话会再次提示。Print、JSON 等非交互模式不会显示提示。

设置保存在 Pi 的 agent 目录中，通常是 `~/.pi/agent/pi-mini-mode.json`；如果 Pi 使用其他配置目录，则保存在对应目录。文件缺失或格式错误时会安全回退到默认设置。设置示例：

```json
{
  "pi-mini-mode-project-branch-show": true,
  "pi-mini-mode-branch-show": false,
  "pi-mini-mode-model-show": true,
  "pi-mini-mode-thinking-show": true,
  "pi-mini-mode-ch-show": true,
  "pi-mini-mode-session-tokens-show": true,
  "pi-mini-mode-cache-tokens-show": false,
  "pi-mini-mode-cache-miss-show": true,
  "pi-mini-mode-cost-show": true,
  "pi-mini-mode-mcp-show": false,
  "pi-mini-mode-context-show": true,
  "pi-mini-mode-context-dots-show": true,
  "pi-mini-mode-context-percent-show": true,
  "pi-mini-mode-speed-show": true,
  "pi-mini-mode-speed-unit-show": true,
  "pi-mini-mode-minimal-show": true,
  "pi-mini-mode-input-enhancements": true,
  "onboardingCompleted": true
}
```

| 配置项 | 默认值 | 说明 |
| --- | --- | --- |
| `pi-mini-mode-project-branch-show` | `true` | 显示项目名称与分支 |
| `pi-mini-mode-branch-show` | `false` | 仅显示分支，代替项目与分支 |
| `pi-mini-mode-model-show` | `true` | 显示不含 provider 前缀的模型 ID |
| `pi-mini-mode-thinking-show` | `true` | 显示思考级别 |
| `pi-mini-mode-ch-show` | `true` | 显示会话缓存命中率（`CH`） |
| `pi-mini-mode-session-tokens-show` | `true` | 显示会话累计令牌（`Total`） |
| `pi-mini-mode-cache-tokens-show` | `false` | 显示缓存读取与写入令牌（已包含在 Total 中） |
| `pi-mini-mode-cache-miss-show` | `true` | 检测到缓存 miss 时显示估算量 |
| `pi-mini-mode-cost-show` | `true` | 显示会话费用估算 |
| `pi-mini-mode-mcp-show` | `false` | 显示已启用的 MCP 服务器数量 |
| `pi-mini-mode-context-show` | `true` | 显示已用/总上下文令牌和进度条 |
| `pi-mini-mode-context-dots-show` | `true` | 使用单行点阵进度条替代实心进度条 |
| `pi-mini-mode-context-percent-show` | `true` | 显示上下文使用百分比 |
| `pi-mini-mode-speed-show` | `true` | 显示最新生成速度 |
| `pi-mini-mode-speed-unit-show` | `true` | 速度子设置：在数字后追加 `tok/s` |
| `pi-mini-mode-minimal-show` | `true` | 极简输出总开关；关闭则恢复 Pi 默认历史显示 |
| `pi-mini-mode-input-enhancements` | `true` | 图片预览、行内技能补全与展开、消息文件链接 |
| `onboardingCompleted` | 初始为 `false` | 防止再次显示首次设置提示的内部标记 |

生成速度设置中的 **显示 tok/s 单位** 是 **显示最新生成速度** 下方的缩进子设置。关闭它只会移除 `tok/s`，保留速度数字；即使隐藏生成速度，该子设置仍会保留。


设置命令需要 Pi 的 TUI 模式。预览使用固定示例数据而非当前会话，但会即时反映每项开关。选中项及对应预览字段会突出显示；全屏支持悬停聚焦、点击切换，普通终端使用键盘操作，悬停本身不会改变设置。

</details>

<details>
<summary><strong>指标如何计算</strong></summary>

会话总量来自当前会话分支中每一条已完成的 `assistant` 和 `toolResult` 记录。工具报告的嵌套 LLM 工作（例如子 Agent）会准确计入一次。若 provider 提供 `totalTokens`，`Total` 使用该值；较旧或自定义结果没有该字段时，则使用输入、输出、缓存读取和缓存写入令牌之和。`Cached` 是缓存读取与写入之和（包含在 `Total` 中）；`CH` 是缓存读取量除以输入量与缓存读取量之和。只有已持久化的最终用量会计入，因此流式更新不会重复累计。

助手生成过程中，速度按 decode TPS 计算：用 provider 的 `usage.output` 除以从第一个输出 token 开始的耗时，不包含 TTFT/预填充等待。至少 2 个输出 token 且解码时长达 100ms 后才显示，并在流式过程中刷新。后续助手消息如果只是调用工具或等待输出，之前完成的速度仍会保留；只有新的可测量主回复才会替换它。嵌套工具里的 LLM 用量不会覆盖已测量的主回复速度；只有还没有主生成速度时，嵌套完成才能写入页脚。过短或单 token 突发不显示，避免虚高的 tok/s。倒退的输出样本和不递增的时间戳会被忽略。

在获得可测量响应前，速度字段完全不显示，不会出现 `-- tok/s` 占位符。速度位于页脚最右侧；启用上下文百分比时，百分比紧邻其左侧。颜色遵循 Pi 主题语义：至少 30 tok/s 为成功色，10–29.9 tok/s 为警告色，低于 10 tok/s 为错误色。费用是基于当前分支已完成用量和配置的每百万令牌费率得出的估算，并非 provider 账单。窄终端中，页脚会丢弃或截断优先级较低的内容，确保保持单行且不溢出。

</details>

<details>
<summary><strong>开发与检查</strong></summary>

开发时只安装本地副本；同时安装 npm 版本和本地版本会导致扩展重复注册：

```bash
pi remove npm:@each1024/pi-mini-mode && pi install /path/to/pi-mini-mode
npm run check
npm test
```

修改源码后，在已打开的 Pi 会话中运行 `/reload`。`npm run check` 会执行 TypeScript 检查，`npm test` 会执行页脚、设置和发布自检。真实终端冒烟测试：

```bash
python3 test/minimal-pty.py
```

该测试需要 Python 3、Node 以及已安装依赖中自带的 Pi CLI；会使用临时 fixture，覆盖普通/全屏模式、切换、10 条过程记录、`Ctrl+O` 展开/收起、恢复结果和窄终端，不会调用模型。

</details>

<details>
<summary><strong>发布</strong></summary>

日常发布在本机完成，使用 `.npmrc` 中的 npm token（`npm publish --access public`）。`publish.yml` 只作为手动备份（在 `main` 上 `workflow_dispatch`）：先执行 `npm ci`、`npm run check` 和 `npm test`，再运行 `scripts/publish.mjs`。该脚本发布本地版本基线与 npm 最新稳定版本再加一个 patch 中的较高者，版本只在 runner 中变更（不创建版本提交或 tag），并跳过已经发布过的提交。发布 major 或 minor 时，同时提高 `package.json` 和 lockfile 中的基线。

备份流程需要为该包配置指向此 GitHub 仓库及 `publish.yml` 的 npm Trusted Publisher。它使用 OIDC 和 provenance，不使用 npm token。

</details>

---

[MIT License](LICENSE) · 为 [Pi](https://pi.dev) 打造
