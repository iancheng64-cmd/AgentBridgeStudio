# Agent Guide

This document is for agents and harness authors integrating `claudex-computer-use`.

For human setup instructions, start with [Installation & Integration](install.md).

## Mental Model

Claudex Computer Use is a local macOS execution layer exposed as MCP tools.

Typical loop:

1. Call `doctor` once to check permissions.
2. Call `get_app_state(app="...")` to get a numbered UI tree and screenshot.
3. Act with `click`, `scroll`, `drag`, `press_key`, `type_text`, or `set_value`.
4. Use the post-action state returned by mutation tools when present.
5. Re-query with `get_app_state` when the UI changed too much or a stale warning appears.

Do not assume element indices are stable across UI changes.

## Startup Checks

Recommended first calls:

```text
doctor
list_apps
get_virtual_cursor
```

If permissions are missing, ask the user to grant Accessibility and Screen Recording to the host process:

- Claude Code: the terminal app running Claude Code
- Codex App: Codex
- Direct binary usage: the compiled server binary or parent terminal

## Choosing Actions

Prefer the highest-level reliable action:

| Situation | Preferred Tool |
|---|---|
| Native button, menu item, row, checkbox | `click(app, element_index)` |
| Editable AX control with settable value | `set_value(app, element_index, value)` |
| Text entry in browser/Electron/WebView apps | `type_text(..., strategy="pasteboard")` |
| Keyboard shortcuts | `press_key(app, key)` |
| Weak AX app where element frame is unreliable | Coordinate fallback only after inspecting screenshot |
| Need to show a demo cursor | `set_virtual_cursor(preset="codexDemo", clear=true)` |

For CJK text, prefer pasteboard-based typing to avoid IME interference.

## Common App Patterns

### Safari

Use keyboard shortcuts for global UI:

```text
press_key(app="Safari", key="super+l")
type_text(app="Safari", text="population of Tokyo", strategy="pasteboard")
press_key(app="Safari", key="Return")
```

Then call `get_app_state` to inspect the page.

### Notes / TextEdit

Prefer `set_value` on settable text controls. It is more reliable than keyboard simulation.

### Calculator

Use `get_app_state`, then click button elements by `element_index`. It is a good sanity test for native AX actions.

### Feishu / Lark / WeChat

Treat these as best-effort:

- AX trees may be sparse.
- Frames may be approximate.
- Some actions may need coordinate fallback.
- Do not send messages unless the user explicitly requested it.
- For public demos, only use fake contacts, fake chats, and test workspaces.

## Virtual Cursor

The desktop virtual cursor is for observation and recordings.

Useful presets:

```text
set_virtual_cursor(preset="codexDemo", clear=true)
set_virtual_cursor(mode="hybrid", style="ghostArrow", show_trail=false)
set_virtual_cursor(mode="off", clear=true)
```

Expected behavior:

- It moves before pointer actions.
- It stays tied to the operated app when possible.
- It should not float above unrelated covering windows.
- It hides when the desktop session is stopped or released.

## Error Recovery

### Stale Snapshot

If you see:

```text
The user changed '<app>'. Re-query the latest state...
```

Call `get_app_state(app="...")` again and use the new element indices.

### Element Not Found

The element index came from an older snapshot or the UI changed. Re-query app state.

### App Not Found

The `app` parameter accepts app name, bundle ID, or PID. The app must be running.

### Missing Screenshot

Check Screen Recording permission. AX state may still work without screenshots, but visual fallbacks become weaker.

## Testing

Developer checks:

```bash
swift build
python3 scripts/smoke-mcp.py
python3 scripts/smoke-mcp-ndjson.py
python3 scripts/test-stale-guard.py
```

Smoke tests verify MCP startup, tool discovery, framing compatibility, and key error surfaces. They are not full app compatibility tests.

## Safety Rules For Agents

- Do not operate apps outside the user's requested scope.
- Do not send messages, emails, payments, or irreversible actions unless explicitly instructed.
- Prefer `get_app_state` before acting in a new app.
- Use `doctor` when behavior suggests missing permissions.
- Use fake data for public demos.
- Report weak-AX limitations honestly instead of pretending coordinates are exact.
