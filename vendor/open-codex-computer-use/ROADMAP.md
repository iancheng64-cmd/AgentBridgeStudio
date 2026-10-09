# Open Claudex Computer Use Roadmap

Open Claudex Computer Use is moving toward a single final shape:

- native macOS execution core
- stdio MCP server for any harness
- Codex plugin wrapper for first-class installation
- local-first permission and allowlist model

## Current State

Implemented in this repo today:

- `ClaudexComputerUseCore`: reusable Swift core for app discovery, permission checks, click injection, keyboard shortcuts, multi-strategy text injection, drag, scroll, desktop session management, virtual cursor overlays, AX element operations, and value setting
- `WindowCapture`: CoreGraphics-backed window listing plus single-window PNG capture with `ScreenCaptureKit` primary and `screencapture` fallback
- `AppStateService`: app-centric snapshots with numbered AX trees, screenshot capture, direct AX refs for round-trip element actions, and per-app execution guidance
- `UIElementService`: AX tree search plus `AXPress` / secondary AX action / `AXValue` execution with serializable `windowIndex` / `path` locators
- `InputInjector`: click, drag, type, and scroll delivery with process-targeted events plus AX-assisted targeting heuristics
- `Allowlist`: per-app bundle ID allowlist with allowAll / allowlistOnly modes, persist-to-disk support, and enforcement on all mutating actions
- `DesktopSessionManager`: shared/exclusive session acquisition, cross-process advisory locking, action budgets, and interruption detection based on frontmost-app / cursor drift
- `VirtualCursor`: screenshot-overlay plus optional live desktop-overlay observability layer for recent click / scroll / drag / value-setting targets
- `claudex-computer-use`: a stdio MCP server with Codex-style app-state-first tools: `get_app_state`, `list_apps`, `click`, `press_key`, `type_text`, `scroll`, `drag`, `perform_secondary_action`, plus session/UX tools (`acquire_desktop`, `desktop_status`, `release_desktop`, `get_virtual_cursor`, `set_virtual_cursor`) and legacy/debug tools such as `capture_window`, `find_ui_element`, `press_element`, `set_value`, `stop`, `get_allowlist`, and `set_allowlist`
- `claudex-computer-use-cli`: a local debugging CLI for the same primitives
- `plugins/claudex-computer-use`: repo-local Codex plugin wrapper
- `.github/workflows/build.yml`: CI build verification

Missing for the intended final product:

- release packaging for npm/homebrew
- end-to-end demo video and docs polish
- app compatibility matrix and failure-mode documentation
- broader real-app validation of the new desktop-session and virtual-cursor UX layer
- broader real-app validation of `type_text` auto/pasteboard/direct delivery heuristics across Electron/WebView-heavy apps

## Alpha Plan

### Alpha 0.1

- validate `CGEventPostToPid` against a real app matrix: TextEdit, Finder, Safari, Chrome, Xcode
- tighten the MCP contract around the tools that already exist
- document known app compatibility and failure modes

### Alpha 0.2

- harden `capture_window` across more app/window classes
- validate `ScreenCaptureKit` vs fallback backend behavior across real apps
- add root and plugin install docs for Codex, Claude Code, and Cursor

### Alpha 0.3

- harden `find_ui_element`
- harden `press_element`
- harden `scroll`
- harden `set_value`
- prefer AX actions over coordinate clicks when possible

## Beta Plan

- wire the existing MCP smoke test into CI
- add GitHub Actions build verification
- end-to-end integration test with Claude Code
- docs site and installation guide

## 1.0 Bar

- reliable mixed-mode execution: AX first, visual fallback
- MCP tools that cover the Codex-style computer-use contract: `get_app_state`, `list_apps`, `click`, `press_key`, `type_text`, `scroll`, `drag`, `perform_secondary_action`
- supporting debug and policy tools for capture, element lookup, element press, value setting, stop, and allowlist management
- Codex plugin that installs cleanly from the repo
- publishable docs and demo assets
