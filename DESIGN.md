---
name: Pi Mini Mode
description: 终端内紧凑、可折叠的工作过程与会话状态。
colors:
  dark-accent: "#5e9cff"
  dark-text: "#f5f5f5"
  dark-muted: "#a1a1aa"
  dark-selection: "#293a5d"
  light-accent: "#2563eb"
  light-text: "#242127"
  light-muted: "#625f68"
  light-selection: "#e3e8f5"
---

# Design System: Pi Mini Mode

## Overview

沿用现有终端视觉系统。用户消息、过程树、最终答案和页脚按任务层次排布，减少过程信息对正文的干扰。

## Colors

主题源为 `themes/cc-dark.json`、`themes/cc-light.json`。运行时使用 Pi 主题的 `text`、`muted`、`accent`、`selectedBg` 等语义色，兼容用户选择的其他主题。

## Typography

字体与字号由终端控制，不在 TUI 中指定像素字号。保留中英文等宽列测量和 ANSI 零宽序列。

## Layout

用户消息水平留白最多两列；过程按时间顺序显示，可展开详情。最终答案直接显示 Markdown。窄窗口按可用列数截断或换行。

## Shapes

终端组件使用字符和主题背景区分边界；不增加装饰角标。

## Components

- 展开的过程标题使用 `selectedBg` 整行底色，保留原有文字颜色。
- 文件和网页链接使用标准 OSC 8，目标独立于显示文字，显示缩短后仍指向完整路径。
- 全屏极简模式的工具、技能和思考记录悬停使用 `selectedBg` 整行高亮；链接悬停局部高亮，Ctrl 鼠标报告增加 ANSI 下划线。Cmd 原生下划线及绕过鼠标捕获的手势由终端处理。
- 移开链接、滚动、改变布局或关闭视图时清除悬停状态；高亮不改变原文和命中区域。

## Do's and Don'ts

- 保持现有明暗主题与折叠交互。
- 按终端能力启用链接，不通过终端名称选择路径渲染逻辑。
- 不假设标准鼠标协议能够报告 Cmd 状态；不宣称所有终端具备相同原生手势。
