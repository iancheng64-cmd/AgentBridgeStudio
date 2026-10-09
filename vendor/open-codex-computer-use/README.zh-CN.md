# 🚀 Open Claudex Computer Use

<p align="center">
  <strong>面向 Claude Code、Codex 和任意 MCP agent 的 macOS 后台 computer-use 执行层。</strong>
</p>

<p align="center">
  • 开源 Codex 风格 Computer Use • 原生 Swift MCP Server • App-aware 虚拟光标 •
</p>

<p align="center">
  <a href="README.md">English</a> •
  <a href="#-新闻栏">新闻栏</a> •
  <a href="#-功能">功能</a> •
  <a href="#-demos">Demo</a> •
  <a href="https://github.com/OpenClaudex/open-claudex-computer-use/releases">下载</a> •
  <a href="#-快速开始">快速开始</a> •
  <a href="#-兼容性">兼容性</a> •
  <a href="CLAUDE.md">Agent Guide</a>
</p>

<p align="center">
  <a href="https://github.com/OpenClaudex/open-claudex-computer-use/releases"><img alt="Release" src="https://img.shields.io/github/v/release/OpenClaudex/open-claudex-computer-use?include_prereleases&label=release"></a>
  <a href="docs/install.md"><img alt="Platform" src="https://img.shields.io/badge/platform-macOS%2013%2B-black"></a>
  <a href="LICENSE"><img alt="License" src="https://img.shields.io/badge/license-MIT-green"></a>
  <a href="Package.swift"><img alt="Swift" src="https://img.shields.io/badge/Swift-5.9%2B-orange"></a>
  <a href="docs/install.md"><img alt="MCP" src="https://img.shields.io/badge/MCP-stdio-blue"></a>
  <img alt="Claude Code" src="https://img.shields.io/badge/Claude%20Code-ready-6b46c1">
  <img alt="Codex" src="https://img.shields.io/badge/Codex-ready-111827">
  <img alt="Feishu and Lark" src="https://img.shields.io/badge/Feishu%2FLark-best--effort-00a6ff">
  <img alt="WeChat" src="https://img.shields.io/badge/WeChat-best--effort-07c160">
</p>

> [!IMPORTANT]
> **🖥️ 从 GUI 到 Agent UI。** 1979 年 12 月，乔布斯在 Xerox PARC 看到 GUI 后，意识到电脑需要一种新的交互界面。第一次看到 Codex Computer Use 时，我也有一个小一号的类似感受：agent 需要自己的“车道”去使用真实 App，才能和人类的 UI 操作更好共生。
>
> **🧭 后台 computer use。** agent 不应该为了完成任务而抢走人的鼠标和键盘。它应该在独立执行通道里操作真实 App，通过 app-aware 虚拟光标保持可见，并用截图 + Accessibility context 保持可恢复。
>
> **🔓 为什么开源。** 官方 Codex Computer Use MCP 没有开源。Open Claudex 要做的是一个可复用的 macOS execution layer，让 Claude Code、Codex 和其他 MCP harness 都能接入。

![Open Claudex Computer Use 架构图](docs/assets/openclaudex-architecture.png)

## 📮 新闻栏

- **[2026.05.12]** 🪽 [Hermes Agent Computer Use](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use) 也来了。方向越来越清楚：agent 需要自己的后台车道，而不是抢人的鼠标。✨
- **[2026.05.11]** 🦞 OpenClaw 也加入了 computer-use 浪潮，推出了 [Computer Use skill](https://openclawai.io/skills/skill/computer-use/)。操作真实 App 正在从 demo 变成 agent 的基础能力。
- **[Launch day]** 🚀 Open Claudex Computer Use 正式公开：面向 Claude Code、Codex 和 MCP agent 的开源 macOS 后台 computer-use 执行层。

## 🧭 快速导航

> [!TIP]
> **我是人类** -> 继续阅读本文档：看 demo、安装方式、兼容性和项目背景。
>
> **我是 Agent** -> 请看 [CLAUDE.md](CLAUDE.md)：结构化操作指南、关键文件和命令速查。

`claudex-computer-use` 是一个原生 Swift MCP server，让 AI agent 能读取和操作真实 Mac App，同时不移动你的真实鼠标，也不需要云端虚拟桌面。

- **给 Claude Code 和 Codex 用**：本地 stdio MCP server，并带 Codex plugin scaffold。
- **操作真实 Mac App**：Safari、Notes、Finder、Calculator、TextEdit、System Settings，以及 Feishu/Lark 这类 WebView-heavy App 的 best-effort 支持。
- **便于演示和观察**：App-aware 虚拟光标、动作后截图、Codex 风格返回。

**状态：** `0.1.0-alpha`

> 本项目不是 Anthropic、OpenAI、Apple 或官方 Codex Computer Use 插件的官方项目。

## 🎬 Demos

| 原生 App 操作 | 后台跨 App 工作流 | 飞书 / Lark Best-Effort |
|---|---|---|
| ![原生 macOS Calculator demo](docs/assets/demo-calculator.gif) | ![Safari 和 Notes 后台工作流 demo](docs/assets/demo-background-safari-notes.gif) | ![飞书和 Lark 安全演示 demo](docs/assets/demo-feishu-lark.gif) |
| 通过 Accessibility 读取和点击原生 macOS App，并显示虚拟光标。 | agent 在 Safari 和 Notes 中工作，同时人可以继续使用电脑。 | 对 WebView-heavy 企业 App 使用 AX + 坐标 fallback。素材只包含假数据。 |

## ⚡ 快速开始

告诉你的 coding agent：

> 从 https://github.com/OpenClaudex/open-claudex-computer-use 安装 Open Claudex Computer Use，并把它配置成我的 agent 可用的 MCP server。

要求 macOS 13+、Swift 5.9+、Accessibility 权限和 Screen Recording 权限。手动安装见：[安装和集成](docs/install.md)。

## ✨ 功能

Open Claudex 聚焦原生 macOS 执行层：

- 通过 Accessibility 和截图读取 App 状态。
- 执行点击、滚动、拖拽、键盘输入、文本输入和 AX actions。
- 返回动作后的状态，减少 agent 每一步都重新 snapshot。
- 提供同进程虚拟光标，方便观察和录屏。
- 同时支持 NDJSON 和 `Content-Length` 两种 MCP stdio 帧格式。

给 agent / 集成者看的调用规则、工具行为和错误恢复见：[Agent Guide](docs/agent-guide.md)。

## 🧩 兼容性

| 等级 | App | 预期表现 |
|---|---|---|
| Stable | Safari, Notes, TextEdit, Calculator, Finder, System Settings | AX tree 完整，截图稳定，语义点击和 `set_value` 支持好 |
| Limited | Chrome, Edge, VS Code, Slack, Cursor | AX 部分可用，需要坐标 fallback 和 pasteboard typing |
| Best-effort | WeChat, Feishu/Lark, 自绘或 WebView-heavy 界面 | AX 稀疏，frame 不稳定，需要更多 fallback |

详细矩阵：[App 兼容性矩阵](docs/compatibility.md)

## 🧪 为什么做

这个项目来自两个方向的实验：Codex 风格的 background computer use，以及 Claude Code 风格的 MCP 扩展。我们缺的是一个可以复用的开源执行层：一个本地 macOS MCP server，任何 agent harness 都可以接进来。

Open Claudex 不是完整 agent harness，而是执行引擎。

## 📚 文档

- [安装和集成](docs/install.md)
- [Agent Guide](docs/agent-guide.md)
- [Demo Pack](docs/demos.md)
- [App 兼容性矩阵](docs/compatibility.md)
- [Testing](docs/testing.md)
- [Codex Native Trace Kit](docs/codex-native-trace-kit.md)
- [Roadmap](ROADMAP.md)

## 🌐 相关项目

Open Claudex 聚焦原生 macOS 执行层。下面是 computer use 和 agent desktop 方向的相关项目：

- [iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use) - Codex 风格的开源 computer-use MCP server。
- [trycua/cua](https://github.com/trycua/cua) - 面向完整桌面 computer-use agent 的 sandbox、SDK 和基础设施。
- [browser-use/macOS-use](https://github.com/browser-use/macOS-use) - 让 macOS App 对 AI agent 更可访问。

## ⭐ Star History

<a href="https://star-history.com/#OpenClaudex/open-claudex-computer-use&Date">
  <picture>
    <source media="(prefers-color-scheme: dark)" srcset="https://api.star-history.com/svg?repos=OpenClaudex/open-claudex-computer-use&type=Date&theme=dark" />
    <source media="(prefers-color-scheme: light)" srcset="https://api.star-history.com/svg?repos=OpenClaudex/open-claudex-computer-use&type=Date" />
    <img alt="Star History Chart" src="https://api.star-history.com/svg?repos=OpenClaudex/open-claudex-computer-use&type=Date" />
  </picture>
</a>

## 📄 License

[MIT](LICENSE)

---

<p align="center">
  如果这个项目对你有帮助，欢迎给一个 ⭐ Star!
</p>

<p align="center">
  <a href="https://github.com/OpenClaudex/open-claudex-computer-use/issues">Report Issues</a> ·
  <a href="https://github.com/OpenClaudex/open-claudex-computer-use/issues/new?labels=enhancement">Feature Requests</a>
</p>
