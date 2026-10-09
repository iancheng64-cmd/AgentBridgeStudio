# App Compatibility Matrix

Claudex Computer Use uses a mixed-mode approach: AX (Accessibility) actions when available, with CGEvent injection and coordinate clicks as fallback. Different apps expose varying levels of AX support, which directly affects reliability.

## Support Tiers

| Tier | Description | Examples |
|------|-------------|---------|
| **Stable** | Rich AX tree, element-index clicks, set_value works, screenshots reliable | Safari, Notes, TextEdit, Calculator, Finder, System Settings |
| **Limited** | Partial AX tree, some actions need coordinate fallback or pasteboard workarounds | Chrome, Edge, Slack, VS Code, Cursor |
| **Best-effort** | Sparse or missing AX tree, CGEvent may be dropped, use at your own risk | WeChat, Feishu/Lark, self-drawn/canvas apps |

## Detailed Matrix

### Tier 1: Stable

| App | Bundle ID | Read | Click | Type | Scroll | Set Value | Notes |
|-----|-----------|------|-------|------|--------|-----------|-------|
| Safari | `com.apple.Safari` | Full AX tree with web area | element_index + coordinate | unicodeEvent for ASCII, pasteboard for CJK | AX action first, event fallback | Settable on address bar and some web fields | Best-supported browser. Use `cmd+l` to focus address bar, element_index for toolbar and page links. |
| Notes | `com.apple.Notes` | Full AX tree | element_index | `set_value` on text area is most reliable | AX action | Full `set_value` support on note body text area | Hero demo app. Prefer `set_value` over type_text for content writing. |
| TextEdit | `com.apple.TextEdit` | Full AX tree | element_index | `set_value` on text area, unicodeEvent for ASCII | AX action | Full support | Similar to Notes. Use `set_value` for document body. |
| Calculator | `com.apple.calculator` | Full AX tree with semantic IDs | element_index (AXPress) | N/A (button-based) | N/A | N/A | Pure AXPress workflow. Each button has a semantic identifier (`AllClear`, `Delete`, digit buttons). |
| Finder | `com.apple.finder` | Full AX tree with outline/row elements | element_index for sidebar, coordinate for content area | `cmd+shift+g` for Go To Folder is most reliable | AX action | Limited | Use keyboard shortcuts (`cmd+shift+g`, `cmd+n`) over tree navigation. Re-snapshot after folder navigation. |
| System Settings | `com.apple.systempreferences` | Full AX tree | element_index | Limited (mostly click-navigate) | AX action | Some toggle switches are settable | Good for demonstrating navigation. Sidebar + content pane structure. |

### Tier 2: Limited

| App | Bundle ID | Read | Click | Type | Scroll | Set Value | Notes |
|-----|-----------|------|-------|------|--------|-----------|-------|
| Chrome | `com.google.Chrome` | AX tree with web area (can be large) | element_index for chrome UI, coordinate for page content | pasteboard recommended for non-ASCII | Event injection (AX scroll limited in web content) | Limited to address bar | Web area can produce 1000+ elements. Snapshot aggressively. |
| Edge | `com.microsoft.edgemac` | Similar to Chrome | Similar to Chrome | pasteboard recommended | Event injection | Limited | Chromium-based, same behavior as Chrome. |
| VS Code | `com.microsoft.VSCode` | Partial AX tree (editor area sparse) | element_index for sidebar/tabs, coordinate for editor | pasteboard for all text | Event injection | Very limited | Electron app. Editor canvas has weak AX fidelity. Prefer keyboard shortcuts. |
| Slack | `com.tinyspeck.slackmacgap` | Partial AX tree (after AXManualAccessibility) | element_index for channel list, coordinate for messages | pasteboard | Limited | Limited | Electron. Main message area may be missing from AX. Prefer `cmd+k` for navigation. |
| Cursor | `com.todesktop.runtime.cursor` | Similar to VS Code | Similar to VS Code | pasteboard | Event injection | Very limited | Electron. Same limitations as VS Code. |

### Tier 3: Best-effort

| App | Bundle ID | Read | Click | Type | Scroll | Set Value | Notes |
|-----|-----------|------|-------|------|--------|-----------|-------|
| WeChat | `com.tencent.xinWeChat` | ~13 elements (self-drawn UI) | Unreliable (CGEvent may be dropped) | Unreliable | Unreliable (CGEvent scroll ignored) | No settable elements | Self-drawn UI. AX tree exposes window frame but not content. Not recommended for automation. |
| Feishu/Lark | `com.bytedance.lark` | Sparse AX tree | Coordinate click only, timing-dependent | pasteboard + `cmd+v`, timing-dependent focus | Unreliable | Very limited | Electron with heavy custom rendering. Input focus is fragile. Works sometimes, fails unpredictably. |
| Discord | `com.hnc.Discord` | Partial AX tree | Coordinate fallback needed | pasteboard | Unreliable | Limited | Electron. Similar to Slack but less AX exposure. |

## Interaction Strategy Guide

### Click

1. **element_index** (preferred): Uses AXPress or AX action. Works without moving the visible cursor. Most reliable for apps with good AX trees.
2. **coordinate click**: Uses `CGEventPostToPid()`. Does not move the system cursor. Works on most apps but may fail on self-drawn UI.

### Type Text

1. **set_value** (most reliable): Directly writes to AXValue. No keyboard focus needed. No clipboard interference. Works on native text fields/areas.
2. **pasteboard** (`strategy=pasteboard`): Copies to clipboard, sends `cmd+v`. Works across most apps including Electron. Restores clipboard after. Requires keyboard focus in target field.
3. **unicodeEvent** (`strategy=unicodeEvent`): Sends CGEvent keyboard events per character. Works for ASCII in native apps. May fail with IME active or in Electron apps.
4. **auto** (default): Chooses pasteboard for Electron apps and non-ASCII text, unicodeEvent otherwise.

### Scroll

1. **AX action** (preferred): Uses `AXScrollUpByPage` / `AXScrollDownByPage`. Works without focus. Preferred when available.
2. **Event injection**: Sends `CGEvent` scroll wheel events to the target PID. May require momentary focus in some apps.

### Delivery Modes

- **background** (default): Events posted to target PID via `CGEventPostToPid()`. System cursor and focus are not moved.
- **direct**: Activates the target app briefly, performs the action, then optionally restores focus. Use when background delivery fails (some Electron apps).

## Known Cross-cutting Limitations

1. **Minimized windows**: macOS does not maintain a render buffer for minimized windows. Screenshots and some AX operations fail. The app must be open (can be behind other windows, just not minimized).

2. **IME interference**: Chinese/Japanese/Korean input methods intercept CGEvent keyboard events. Always use `strategy=pasteboard` for CJK text.

3. **Focus fragility in Electron apps**: CGEvent keyboard events reach the process but may not route to the correct input field inside a WebView. Use `delivery=direct` as the main workaround; it restores focus by default, and you can set `restore_focus=false` only when you intentionally want the target app to stay frontmost.

4. **AX tree size**: Some apps (especially browsers with complex pages) can produce 2000+ AX elements. Claudex Computer Use caps at 3000 nodes and 12 depth levels.

5. **Transient UI**: Sheets, popovers, and modal dialogs can replace the main window's AX tree. Always re-snapshot after navigation or dismissal.

6. **Screen Recording permission**: Required for screenshots. Without it, `get_app_state` still returns the AX tree but no screenshot.

## Comparison with Peers

Claudex Computer Use's mixed-mode approach is consistent with other macOS background computer-use tools:

- All use AXPress/AXValue as the primary interaction path
- All fall back to CGEvent coordinate clicks
- All struggle with self-drawn UI (WeChat, canvas apps)
- All require Accessibility + Screen Recording permissions
- Background operation means "not frontmost" but "not minimized"

The honest boundary: **native AppKit/SwiftUI apps are well-supported, Electron apps are workable with workarounds, and self-drawn apps are best-effort.** This is a platform limitation, not a tool limitation.
