<p>
  <img src="https://raw.githubusercontent.com/eachann1024/pi-mini-mode/main/assets/readme-cover.en.svg" alt="Pi Mini Mode — Less noise. More focus. Image input, foldable conversations, subagents, themes and a live footer." width="100%">
</p>

[中文](https://github.com/eachann1024/pi-mini-mode/blob/main/README.zh-CN.md) · [Install](#install) · [Features](#features) · [Reference](#reference)

# Pi Mini Mode

**Less noise. More focus.**

An everyday refinement for [Pi](https://pi.dev), not just a footer. Preview images at the cursor, fold long messages and process details, inspect subagent work, and keep your session’s essential signals in view.

<details>
<summary>See the full interface</summary>

<img width="1698" height="1588" alt="Pi Mini Mode interface" src="https://github.com/user-attachments/assets/9990b080-f82b-4dd0-bc7b-a0cdded72181" />

</details>

## Install

```bash
pi install npm:@each1024/pi-mini-mode
```

In an open Pi session, run Pi's built-in `/reload` command. On first use, choose **Apply recommended setup** for a bundled theme and fullscreen mode, then restart Pi for fullscreen to take effect. Configure this extension any time with `/pi-mini-mode-settings`. Project settings and CLI flags may override global settings.

**Pi ≥ 0.84.0.** Input enhancements and minimal output are on by default. Minimal mode uses a private **Pi 0.85.x** layout adapter—see [compatibility](#compatibility) before enabling it.

### Update an existing npm installation

```bash
pi update npm:@each1024/pi-mini-mode
```

Then run `/reload` in Pi and reopen `/pi-mini-mode-settings` (or restart Pi). The HTML settings page ships with the extension; no separate npm command or development server is needed. Publishing does not update users' installed copies or already-open browser tabs automatically. Pinned versions must first be replaced with the unversioned install command above; local development installs continue to use local files.

<details>
<summary>Install from GitHub instead</summary>

```bash
pi install git:github.com/eachann1024/pi-mini-mode
```

</details>

## Features

### 01 / Input, refined

<img width="1092" height="764" alt="Image previews and compact labels in Pi Mini Mode" src="https://github.com/user-attachments/assets/2ea6d037-d3f0-423c-8588-17992a49d445" />

**Images at your cursor.** Move the editing cursor into an image path or compact label to preview it. Fullscreen also supports editor hover. Press `Esc` to dismiss.

**Less path clutter. Same image.** Image paths become underlined `[image1]` labels in the editor and messages, preserving the original path when submitted. Open the original image or another linked file in its default app using your terminal’s link gesture.

**Skills where you type.** Enter `/` at the start or after whitespace to find a skill and insert `/skill:name` at the cursor. Inline skills expand on submission; URLs and paths keep their normal behavior.

Paste images with `Ctrl+V` (`Alt+V` on Windows/WSL). Disabling input enhancements preserves Pi’s native clipboard behavior.

### 02 / Process, quieter

Enable **Minimal output** in `/pi-mini-mode-settings`.

<img width="1092" height="764" alt="Folded process tree in minimal output" src="https://github.com/user-attachments/assets/eb8c88f6-84af-499e-b105-5395b4f02e66" />

- **Long prompts, folded.** In fullscreen minimal mode, long user messages show the first four rendered rows. Click the fold control to reveal the rest. Complete fenced code blocks stay intact.
- **Subagents, in plain sight.** Click a subagent row to expand its available activity and message/final output. In minimal mode, this extension uses `Ctrl+S` to expand or collapse completed subagent summaries; Pi's focused selectors keep their own keys. A dispatch receipt or returned tool call is not a completed background task.
- **A process tree, not a wall of output.** Thinking, tools and skill reads share one chronological tree. The latest summaries stay visible, including the latest thinking; `Ctrl+O` expands or collapses the full process. New questions start collapsed.
- **Tool details on demand.** Expand a tool or thinking entry, including the latest thinking, using its fold control. Thinking starts collapsed and only expands or collapses manually, including while running. Tool details show saved text, not the original custom renderer or image output.
- **Room for the answer.** Final Markdown streams without extra headings or backgrounds. Failures and interruptions stay explicit. Folding changes presentation, not stored session messages.

Turn **Minimal output** off in settings to restore native Pi history.

<img width="1092" height="764" alt="Expanded process details" src="https://github.com/user-attachments/assets/53f5aa28-4b96-45db-b02e-0108aa9e68bc" />

### 03 / Session, in focus

**Light and dark, considered.** Includes `cc-light` and `cc-dark`, derived from [pi-cc-extensions](https://github.com/minuque/pi-cc-extensions) under MIT. User messages use the theme’s user-message surface; Markdown, highlighted code, tables and supported Mermaid diagrams adapt to the theme. Unsupported, incomplete or over-wide diagrams retain their source.

**The useful signals, in one line.** Model and thinking level, session tokens, cache totals and hit rate, estimated cost, context usage and generation speed. Choose your fields in `/pi-mini-mode-settings`; changes take effect immediately, and the footer adapts to narrow terminals.

<details>
<summary>See the footer settings and demo</summary>

[![Existing footer settings screenshot](https://raw.githubusercontent.com/eachann1024/pi-mini-mode/main/assets/pi-mini-mode-settings.jpg)](https://raw.githubusercontent.com/eachann1024/pi-mini-mode/main/assets/pi-mini-mode-settings.jpg)

[Watch the footer settings demo](https://github.com/user-attachments/assets/5f2f4816-45ed-4759-b035-d9ee59e8a763)

This earlier screenshot and recording show footer configuration, not the newer image, folding or subagent features. Settings previews use sample data.

</details>

## Compatibility

- **Images:** previews require a terminal image protocol; unsupported terminals show a hint. Image reads are limited to **20 MB**, and deleted files cannot be reopened. Link gestures depend on the terminal: usually `Cmd+click` on macOS or `Ctrl+click` on Windows/Linux; Ghostty fullscreen may require `Shift+Cmd` / `Shift+Ctrl`. Pi fullscreen also supports direct link clicks. See [Pi terminal setup](https://github.com/earendil-works/pi-mono/blob/main/packages/coding-agent/docs/terminal-setup.md).
- **Minimal output:** uses a private Pi 0.85.x layout adapter without patching Pi’s installation. Unknown layouts refuse activation and keep native output. Recheck after Pi upgrades; other transcript-replacing extensions can conflict.
- **Subagents:** the pi-subagents widget adapter runs only in minimal mode, restores on disable, and passes unknown formats through. Available details depend on the integration’s status/output data; this is not a complete subagent transcript viewer.
- **History:** `/reload` remounts the transcript, including history created in native mode. Empty progress events do not erase existing content; tools without output show elapsed waiting time. Legacy per-item minimal controls no longer filter content.
- **Metrics:** costs are estimates, not provider invoices. See the calculation details below.

## Reference

<details>
<summary><strong>First run & configuration</strong> — defaults, controls, and settings file</summary>

On the first interactive TUI session, Pi Mini Mode shows a preview. **Branch-only**, **Cached tokens**, and **MCP count** are off by default; branch-only is mutually exclusive with **project & branch**. Change anything later with `/pi-mini-mode-settings`.

Example with optional Cached and MCP fields enabled:

```text
deepseek-v4-flash  high  Total 45K  Cached 25K  CH 40.0%  $0.012  ◇ MCP 3  500/1.0M  ⣿⣀⣀⣀⣀⣀⣀⣀⣀⣀  1%  120 tok/s
```

The first-run picker offers **Keep defaults**, **Configure now**, and **Apply recommended setup**. Keeping defaults saves the default field selection, leaves minimal output on, and prevents the prompt from appearing again; configuring opens the same settings list immediately. Applying the recommendation asks you to choose the bundled `cc-dark` or `cc-light` theme, saves that theme and global `tuiMode=fullscreen` through Pi's settings API, applies the theme immediately, and asks you to restart Pi because the fullscreen renderer is chosen at startup. Project settings and CLI flags may override these global values. Escape/cancel leaves onboarding incomplete; it runs again on the next interactive session. Print, JSON, and other non-interactive modes never prompt.

Open that settings UI any time with:

```text
/pi-mini-mode-settings
```

The focused option and its corresponding preview field use bold theme `accent` text with a `selectedBg` background. Fullscreen Pi supports hover to focus and click to toggle; regular terminal mode uses keyboard navigation. Hovering never changes a setting.

Changes take effect immediately. The command requires Pi's TUI mode. Its preview always uses fixed example data rather than your current session, while reflecting every setting toggle immediately.

Settings are stored globally at Pi's agent directory (normally `~/.pi/agent/pi-mini-mode.json`; installations with a different Pi config directory use that directory). A malformed or missing file safely falls back to the defaults.

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

| Key | Default | Controls |
| --- | --- | --- |
| `pi-mini-mode-project-branch-show` | `true` | Project name and branch |
| `pi-mini-mode-branch-show` | `false` | Branch only, instead of project and branch |
| `pi-mini-mode-model-show` | `true` | Model ID without provider prefix |
| `pi-mini-mode-thinking-show` | `true` | Thinking level |
| `pi-mini-mode-ch-show` | `true` | Session cache-hit rate (`CH`) |
| `pi-mini-mode-session-tokens-show` | `true` | Accumulated session tokens (`Total`) |
| `pi-mini-mode-cache-tokens-show` | `false` | Accumulated cache read + cache write tokens |
| `pi-mini-mode-cache-miss-show` | `true` | Estimated cache misses when detected |
| `pi-mini-mode-cost-show` | `true` | Estimated session list price |
| `pi-mini-mode-mcp-show` | `false` | Enabled MCP server count |
| `pi-mini-mode-context-show` | `true` | Used/total context tokens and progress bar |
| `pi-mini-mode-context-dots-show` | `true` | Use a single-line dot-matrix bar instead of the solid bar |
| `pi-mini-mode-context-percent-show` | `true` | Context-use percentage |
| `pi-mini-mode-speed-show` | `true` | Generation speed at the far right |
| `pi-mini-mode-speed-unit-show` | `true` | Generation-speed sub-setting: append `tok/s` to the numeric value |
| `pi-mini-mode-minimal-show` | `true` | Minimal output; off restores Pi's default conversation history |
| `pi-mini-mode-input-enhancements` | `true` | Image previews, inline skills, and message file links |
| `onboardingCompleted` | `false` initially | Internal marker that prevents another first-run prompt |

- **Generation speed**
  - **Show tok/s unit** (`pi-mini-mode-speed-unit-show`) is the indented sub-setting shown beneath **Show latest generation speed** in `/pi-mini-mode-settings`. Turning it off keeps the speed number (for example `40.0`) and removes only `tok/s`.
  - The sub-setting is retained when generation speed itself is hidden.

</details>

<details>
<summary><strong>How metrics work</strong> — tokens, cache, speed, and estimated price</summary>

Session totals are aggregated from each finalized `assistant` and `toolResult` entry on the active session branch. This includes nested LLM work reported by tools (such as a child agent) exactly once. `Total` uses the provider's `totalTokens` when supplied; older/custom results without it fall back to the sum of input, output, cache-read, and cache-write tokens. `Cached` is cache-read + cache-write (included in Total); `CH` is cache-read / (input + cache-read). Only persisted finalized usage is counted, so stream updates cannot double count totals.

During an assistant stream, speed is decode TPS: provider `usage.output` divided by elapsed time from the first output token, excluding TTFT/prefill wait. It appears after at least two output tokens and 100ms of decode time, and is refreshed while streaming. The completed rate remains visible while later assistant messages only call tools or wait for output; it is replaced only by a newer measurable main-turn generation. Nested tool LLM usage does not overwrite a measured main-turn rate; it can set the footer only when no main generation has been measured yet. Short or single-token bursts are hidden rather than shown as inflated tok/s. Regressing output samples and non-increasing timestamps are ignored.

Before a measurable response exists, the speed field is absent entirely—Pi Mini Mode never displays a `-- tok/s` placeholder. When present, speed is the rightmost footer field (the context percentage, if enabled, is immediately to its left). Its color uses Pi theme semantics: **success** at >=30 tok/s, **warning** at 10–29.9 tok/s, and **error** below 10 tok/s. No colors are hard-coded, so it follows the selected Pi theme.

The price is the same finalized active-branch usage and configured per-million-token rates. It is an estimate, not a provider invoice. In narrow terminals, the footer drops/truncates lower-priority content to remain one line without overflow.

</details>

<details>
<summary><strong>Development</strong> — local setup and checks</summary>

Install only the local copy while developing; installing npm and local copies together double-registers the extension:

```bash
pi remove npm:@each1024/pi-mini-mode && pi install /path/to/pi-mini-mode
npm run check
npm test
```

After source changes, run `/reload` in an already-open Pi session. `npm run check` runs TypeScript checking and `npm test` runs the project self-checks.

For a real terminal smoke test, run `python3 test/minimal-pty.py`. It needs Python 3, Node, and the installed dependency’s bundled Pi CLI. Temporary fixtures cover regular/fullscreen output, toggling, process expansion, restored results, and narrow terminals without model calls.

</details>

<details>
<summary><strong>Publishing</strong></summary>

Normal releases are published from this machine with the npm token in `.npmrc` (`npm publish --access public`). `publish.yml` is only a manual backup (`workflow_dispatch` on `main`): it runs `npm ci`, `npm run check`, and `npm test`, then `scripts/publish.mjs`. That script publishes the higher of the local version baseline and npm's latest stable version plus one patch, changes the version only in the runner (no version commit or tag), and skips commits that are already published. Raise the baseline in `package.json` and the lockfile for a major or minor release.

The backup workflow needs the package’s npm Trusted Publisher configured for this GitHub repository and `publish.yml`. It uses OIDC and provenance and does not use an npm token.

</details>

---

[MIT License](LICENSE) · Built for [Pi](https://pi.dev)
