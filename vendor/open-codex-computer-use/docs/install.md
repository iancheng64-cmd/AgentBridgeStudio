# Installation & Integration

## Requirements

- macOS 13.0+ (Ventura or later)
- Swift 5.9+ toolchain (Xcode 15+)
- Accessibility permission granted
- Screen Recording permission granted (for screenshots)

## Build from Source

```bash
git clone https://github.com/OpenClaudex/open-claudex-computer-use.git
cd open-claudex-computer-use
swift build
```

This produces:
- `.build/debug/claudex-computer-use` — the MCP server
- `.build/debug/claudex-computer-use-cli` — the debug CLI
- `.build/debug/claudex-computer-use-overlay-helper` — legacy overlay helper kept for screenshot/debug compatibility

For a release build:

```bash
swift build -c release
```

## Permissions

Claudex Computer Use requires two macOS permissions:

### Accessibility

System Settings > Privacy & Security > Accessibility

Grant access to the **host process** that runs Claudex Computer Use:
- If using Claude Code: grant access to your terminal app (Terminal.app, iTerm2, Warp, etc.)
- If using Codex: grant access to the Codex process
- If running directly: grant access to the compiled binary

### Screen Recording

System Settings > Privacy & Security > Screen Recording

Same host process as above. Without this, `get_app_state` returns the AX tree but no screenshot, and `capture_window` / `list_windows` will fail.

### Verify Permissions

```bash
# Via CLI
swift run claudex-computer-use-cli doctor --prompt

# Via MCP (after setup)
# Call the "doctor" tool — it reports permission status
```

## MCP Integration

Claudex Computer Use is a stdio MCP server. It auto-detects the framing format used by the client:

- **NDJSON** (`{...}\n`) — used by Claude Code 2.1.77+ / MCP SDK protocol `2025-11-25`
- **Content-Length** (`Content-Length: N\r\n\r\n{...}`) — used by older MCP clients and Codex

No configuration needed — the server detects the format from the first byte of the first message.

### Claude Code

```bash
# One-line setup
claude mcp add claudex-computer-use -- /path/to/open-claudex-computer-use/.build/debug/claudex-computer-use

# Or for release build
claude mcp add claudex-computer-use -- /path/to/open-claudex-computer-use/.build/release/claudex-computer-use

# Verify
claude mcp list
# Should show: claudex-computer-use ... - ✓ Connected
```

This writes to your Claude Code MCP config. After adding, restart Claude Code.

### Codex App (Plugin)

The repo includes a Codex plugin scaffold:

```
plugins/claudex-computer-use/.codex-plugin/plugin.json
plugins/claudex-computer-use/.mcp.json
```

To use:
1. Build the project (`swift build`)
2. Add this local plugin directory to Codex:

```
/path/to/open-claudex-computer-use/plugins/claudex-computer-use
```

3. The plugin starts `.build/debug/claudex-computer-use`
4. Grant Accessibility and Screen Recording permissions to Codex if Codex is the host process

### Codex CLI / Generic MCP

Use the server as a normal stdio MCP command:

```json
{
  "mcpServers": {
    "claudex-computer-use": {
      "command": "/path/to/open-claudex-computer-use/.build/debug/claudex-computer-use"
    }
  }
}
```

### Cursor

Add to your Cursor MCP settings (`.cursor/mcp.json` in your project or global config):

```json
{
  "mcpServers": {
    "claudex-computer-use": {
      "command": "/path/to/open-claudex-computer-use/.build/debug/claudex-computer-use"
    }
  }
}
```

### Generic MCP Client

Any MCP client that supports stdio transport can use Claudex Computer Use. The server binary is the only thing needed:

```bash
/path/to/open-claudex-computer-use/.build/debug/claudex-computer-use
```

The server exposes 23 tools. See `scripts/smoke-mcp.py` for a complete handshake example.

## Verify the Setup

### Smoke Tests

```bash
# Must build first
swift build

# Content-Length framing (legacy / Codex)
python3 scripts/smoke-mcp.py

# NDJSON framing (Claude Code)
python3 scripts/smoke-mcp-ndjson.py
```

Both scripts verify:
- MCP handshake and tool discovery
- `doctor`, `desktop_status`, and `get_virtual_cursor`
- `set_virtual_cursor` schema, including the `style` field
- Dual framing compatibility (Content-Length + NDJSON)
- MCP handshake (initialize + notifications/initialized)
- All 23 tools are listed
- `doctor` returns valid structured response

The NDJSON script additionally verifies:
- Stale guard: `click` without prior `get_app_state` returns the expected Codex-compatible warning

### Quick Manual Test

After MCP integration, try these tool calls in order:

```
1. doctor              — check permissions and status
2. list_apps           — see running apps
3. get_app_state(app="Safari")  — snapshot Safari's AX tree + screenshot
4. click(app="Safari", element_index=<N>)  — click an element from the snapshot
```

## CLI Reference

The debug CLI is available for local testing without an MCP client:

```bash
# Check permissions
swift run claudex-computer-use-cli doctor --prompt

# List running apps
swift run claudex-computer-use-cli list-apps

# List windows for an app
swift run claudex-computer-use-cli list-windows --pid <PID>

# Click at coordinates
swift run claudex-computer-use-cli click <PID> <X> <Y>

# Scroll
swift run claudex-computer-use-cli scroll <PID> down --amount 12

# Capture a window
swift run claudex-computer-use-cli capture-window <PID> --output /tmp/window.png

# Find a UI element
swift run claudex-computer-use-cli find-ui-element <PID> --role button --text OK

# Press an element
swift run claudex-computer-use-cli press-element <PID> --window-index 0 --path 0,2,1

# Set a value
swift run claudex-computer-use-cli set-value <PID> --window-index 0 --path 0,0 --type string "hello"

# Type text
swift run claudex-computer-use-cli type-text <PID> "hello from claudex-computer-use"
```

## Troubleshooting

### "Accessibility permission is required"

The host process (terminal, Claude Code, Codex) needs Accessibility permission. Check System Settings > Privacy & Security > Accessibility.

### "Screen Recording permission is required"

Same host process needs Screen Recording permission. Required for screenshots and window listing.

### "The user changed '...'. Re-query the latest state"

This Codex-compatible stale warning appears when the snapshot context is missing or invalidated. Call `get_app_state` to get fresh element indices. Note: mutation tools (`click`, `type_text`, `press_key`, etc.) now return a post-action app state snapshot with a new element tree and screenshot, so you do not need to call `get_app_state` between every mutation. You only need it to bootstrap a new interaction or recover from this stale warning.

### "App not found"

The `app` parameter accepts: app name ("Safari"), bundle ID ("com.apple.Safari"), or PID ("12345"). The app must be running (not just installed).

### "Element index not found"

Element indices come from the most recent `get_app_state` snapshot. If the UI changed, call `get_app_state` again to get fresh indices.

### Screenshots are blank or missing

The target app must not be minimized. It can be behind other windows but must have an open window. Check that Screen Recording permission is granted.
