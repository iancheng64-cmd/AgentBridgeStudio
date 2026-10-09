# 🚀 Open Claudex Computer Use

<p align="center">
  <strong>Background computer use for Claude Code, Codex, and MCP agents on macOS.</strong>
</p>

<p align="center">
  • Open Source Codex-style Computer Use • Native Swift MCP Server • App-Aware Virtual Cursor •
</p>

<p align="center">
  <a href="README.zh-CN.md">中文文档</a> •
  <a href="#-news">News</a> •
  <a href="#-features">Features</a> •
  <a href="#-demos">Demo</a> •
  <a href="https://github.com/OpenClaudex/open-claudex-computer-use/releases">Downloads</a> •
  <a href="#-quick-start">Quick Start</a> •
  <a href="#-compatibility">Compatibility</a> •
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
> **🖥️ From GUI to Agent UI.** In December 1979, when Steve Jobs saw the GUI at Xerox PARC, it became obvious that computers needed a new interface. The first time I saw Codex Computer Use, I felt a smaller version of that: agents need their own lane to use real apps and coexist better with human UI work.
>
> **🧭 Background computer use.** An agent should not have to steal your mouse and keyboard to get work done. It should operate in a separate lane, stay visible through an app-aware virtual cursor, and keep enough screenshot + Accessibility context to recover.
>
> **🔓 Why open source it?** The official Codex Computer Use MCP is not open source. Open Claudex is an open macOS execution layer for Claude Code, Codex, and other MCP harnesses.

![Open Claudex Computer Use architecture](docs/assets/openclaudex-architecture.png)

## 📮 News

- **[2026.05.12]** 🪽 [Hermes Agent Computer Use](https://hermes-agent.nousresearch.com/docs/user-guide/features/computer-use) is here too. The direction is getting clearer: agents need their own background lane, not your cursor. ✨
- **[2026.05.11]** 🦞 OpenClaw joined the computer-use wave with a [Computer Use skill](https://openclawai.io/skills/skill/computer-use/). Real-app operation is becoming a standard agent primitive.
- **[Launch day]** 🚀 Open Claudex Computer Use is public: an open-source macOS background computer-use layer for Claude Code, Codex, and MCP agents.

## 🧭 Quick Navigation

> [!TIP]
> **I'm a human** -> Continue reading this README for demos, setup, compatibility, and project context.
>
> **I'm an agent** -> Read [CLAUDE.md](CLAUDE.md) for structured operating instructions, key files, and command quick reference.

`claudex-computer-use` is a native Swift MCP server that lets AI agents inspect and operate real Mac apps without moving your real mouse or requiring a cloud desktop.

- **For Claude Code and Codex**: local stdio MCP server plus a Codex plugin scaffold.
- **For real Mac apps**: Safari, Notes, Finder, Calculator, TextEdit, System Settings, and best-effort WebView-heavy apps such as Feishu/Lark.
- **For demos and trust**: app-aware virtual cursor overlay, post-action screenshots, and Codex-style responses.

**Status:** `0.1.0-alpha`

> Not affiliated with Anthropic, OpenAI, Apple, or the official Codex Computer Use plugin.

## 🎬 Demos

| Native App Control | Background Cross-App Work | Feishu / Lark Best-Effort |
|---|---|---|
| ![Native macOS Calculator demo](docs/assets/demo-calculator.gif) | ![Background Safari and Notes demo](docs/assets/demo-background-safari-notes.gif) | ![Sanitized Feishu and Lark demo](docs/assets/demo-feishu-lark.gif) |
| Click and read native macOS apps through Accessibility, with a visible virtual cursor. | Let the agent work in Safari and Notes while you keep using the Mac. | Operate WebView-heavy enterprise apps with mixed AX and coordinate fallbacks. Sanitized demo data only. |

## ⚡ Quick Start

Tell your coding agent:

> Install Open Claudex Computer Use from https://github.com/OpenClaudex/open-claudex-computer-use and configure it as an MCP server for my agent.

Requires macOS 13+, Swift 5.9+, Accessibility permission, and Screen Recording permission. For manual setup, see [Installation & Integration](docs/install.md).

## ✨ Features

Open Claudex focuses on the native macOS execution layer:

- Reads app state through Accessibility and screenshots.
- Performs clicks, scrolling, dragging, keyboard input, text entry, and AX actions.
- Returns post-action state so agents can continue without excessive re-snapshotting.
- Shows a same-process virtual cursor for observation and recordings.
- Supports both NDJSON and `Content-Length` MCP stdio framing.

For agent-facing usage rules, tool behavior, and recovery patterns, read [Agent Guide](docs/agent-guide.md).

## 🧩 Compatibility

| Tier | Apps | Expected Behavior |
|---|---|---|
| Stable | Safari, Notes, TextEdit, Calculator, Finder, System Settings | Strong AX tree, screenshots, semantic clicks, `set_value` |
| Limited | Chrome, Edge, VS Code, Slack, Cursor | Partial AX, coordinate fallback, pasteboard-heavy typing |
| Best-effort | WeChat, Feishu/Lark, self-drawn or WebView-heavy surfaces | Sparse AX, unreliable frames, more fallback logic |

Details: [App Compatibility Matrix](docs/compatibility.md)

## 🧪 Why This Exists

This project started from two converging workflows: Codex-style background computer use and Claude Code-style MCP extensibility. The missing piece was a reusable open-source execution layer: a local macOS MCP server that any agent harness can plug into.

Open Claudex is not a full agent harness. It is the execution engine.

## 📚 Docs

- [Installation & Integration](docs/install.md)
- [Agent Guide](docs/agent-guide.md)
- [Demo Pack](docs/demos.md)
- [App Compatibility Matrix](docs/compatibility.md)
- [Testing](docs/testing.md)
- [Codex Native Trace Kit](docs/codex-native-trace-kit.md)
- [Roadmap](ROADMAP.md)

## 🌐 Related Projects

Open Claudex focuses on the native macOS execution layer. Related projects around computer use and agent desktops:

- [iFurySt/open-codex-computer-use](https://github.com/iFurySt/open-codex-computer-use) - open-source Codex-style computer-use MCP server.
- [trycua/cua](https://github.com/trycua/cua) - sandbox, SDK, and infrastructure for full desktop computer-use agents.
- [browser-use/macOS-use](https://github.com/browser-use/macOS-use) - making macOS apps accessible to AI agents.

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
  If this project helps you, please give it a ⭐ Star!
</p>

<p align="center">
  <a href="https://github.com/OpenClaudex/open-claudex-computer-use/issues">Report Issues</a> ·
  <a href="https://github.com/OpenClaudex/open-claudex-computer-use/issues/new?labels=enhancement">Feature Requests</a>
</p>
