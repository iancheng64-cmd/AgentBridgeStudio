# CLAUDE.md

This file is the short entrypoint for Claude Code and other coding agents working on Open Claudex Computer Use.

For the full operating guide, read [docs/agent-guide.md](docs/agent-guide.md).

## Project Purpose

`claudex-computer-use` is a native Swift MCP server for operating real macOS apps through Accessibility, screenshots, and an app-aware virtual cursor.

## Key Files

- `Sources/GhostCursorMCP/main.swift` - MCP tool registration, tool schemas, and request handling.
- `Sources/GhostCursorCore/` - Accessibility, screenshots, app guidance, and virtual cursor implementation.
- `Sources/GhostCursorOverlayHelper/` - legacy overlay helper kept for compatibility paths.
- `docs/agent-guide.md` - tool behavior, recovery patterns, and safety rules for agents.
- `docs/install.md` - install and integration instructions.

## Common Commands

```bash
swift build
python3 scripts/smoke-mcp.py
python3 scripts/smoke-mcp-ndjson.py
python3 scripts/test-stale-guard.py
```

## Agent Rules

- Keep README human-facing and concise; put detailed agent behavior in `docs/agent-guide.md`.
- Do not commit local trace files, private recordings, real Feishu/Lark data, or personal paths.
- Do not claim official affiliation with Anthropic, OpenAI, Apple, Claude Code, or Codex.
- Prefer small, surgical changes and verify with `swift build` when touching Swift code.
