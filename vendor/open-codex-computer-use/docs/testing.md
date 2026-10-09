# Testing

## Automated Smoke Tests

Two protocol-level smoke tests cover both MCP framing formats:

| Script | Framing | What it tests |
|--------|---------|---------------|
| `scripts/smoke-mcp.py` | Content-Length | Handshake, 23 tools, doctor, desktop_status, virtual_cursor, schema fields |
| `scripts/smoke-mcp-ndjson.py` | NDJSON | Handshake, 23 tools, doctor, stale guard |
| `scripts/test-capture-timeout-fallback.py` | Content-Length | Verifies `capture_window` / `get_app_state` do not hang when ScreenCaptureKit stalls and fall back to `screencapture` |

Run both after any transport or tool change:

```bash
swift build
python3 scripts/smoke-mcp.py
python3 scripts/smoke-mcp-ndjson.py
python3 scripts/test-capture-timeout-fallback.py Calculator
```

## Stale Guard Tests

`scripts/test-stale-guard.py` verifies three error surfaces:

1. **No prior snapshot**: `click` without `get_app_state` returns `"The user changed '<app>'. Re-query the latest state..."` (Codex-compatible stale warning)
2. **Invalid element index**: `click` with out-of-range index returns a clear error with element count
3. **Dead PID**: `click` targeting a non-existent PID returns `appNotFound` in Codex error style

```bash
python3 scripts/test-stale-guard.py
```

## Claude Code Integration Test

```bash
# 1. Verify health check
claude mcp list
# Expected: claudex-computer-use ... - ✓ Connected

# 2. Functional test (in a new Claude session)
# Ask Claude to use the `claudex-computer-use` MCP server to call `get_app_state` on Safari
# Verify: tool is called, AX tree + screenshot returned
```

## Mutation Validation (manual)

Tested against Finder (2026-04-24). Results in `test-results/mutation-finder-2026-04-24.json`.

| Step | Tool | Result |
|------|------|--------|
| get_app_state(Finder) | Read | 3001 elements, screenshot present |
| click(element_index=N) | Mutation | Post-action state + screenshot returned |
| press_key(super+n) | Mutation | New Finder window opened, post-action state returned |
| get_app_state(Finder) | Read | Confirmed new window in element tree |
| scroll(down, amount=3) | Mutation | Success, virtualCursorApplied=true |
| press_key(super+w) | Mutation | Window closed, confirmed in post-action state |

Key findings:
- All mutation tools return **post-action state** (re-snapshot after action)
- All mutation responses include **screenshot**
- Element count capped at 3001 (AX tree hard cap)
- Virtual cursor overlay applied to scroll responses

## MCP Protocol Compatibility

The `StdioTransport` auto-detects framing from the first byte:

| First byte | Format | Used by |
|------------|--------|---------|
| `{` | NDJSON (`JSON\n`) | Claude Code 2.1.77+, MCP SDK 2025-11-25 |
| `C` | Content-Length (`Content-Length: N\r\n\r\n{...}`) | Codex, older MCP clients, smoke-mcp.py |

Response format matches the detected input format.

## Virtual Cursor Style Validation

`set_virtual_cursor` now accepts a preset plus explicit overrides:

- `preset="codexDemo"`: default Codex-like live arrow, no trail
- `preset="debugTrace"`: crosshair + screenshot trail for diagnostics
- `style="ghostArrow"`: Codex-like blue-gray arrow
- `style="secondCursor"`: darker legacy alternate pointer
- `style="crosshair"`: legacy debug marker

Recommended manual check:

```text
set_virtual_cursor(preset="codexDemo", clear=true)
set_virtual_cursor(mode="hybrid", style="secondCursor", clear=true)
set_virtual_cursor(preset="debugTrace", clear=true)
```

## Known Limitations

These apply to all accessibility-based approaches (including Apple's official CUA):

- **Weak AX apps** (WeChat, Feishu, custom canvas apps): Element tree may be incomplete or missing. AX actions may not work. Coordinate-based fallback is available but less reliable.
- **Electron apps** (Chrome, VS Code, Slack): AX tree is functional but may have inconsistencies. Classified as "Limited" tier in `docs/compatibility.md`.
- **Element cap**: AX tree snapshots cap at ~3000 elements. Large/complex windows may be truncated.
- **Background delivery**: Some apps only respond to key/click events when focused. Use `delivery="direct"` as fallback.
