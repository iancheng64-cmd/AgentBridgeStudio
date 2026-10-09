# Demo Pack

Prompts and scripts for demonstrating Claudex Computer Use capabilities.

For native Codex reverse-engineering prompts that are designed to expose rollout traces rather than showcase Claudex Computer Use, see [Codex Native Trace Kit](codex-native-trace-kit.md).

## Public Demo GIFs

The README uses three short, privacy-safe GIFs:

| File | Scenario | Privacy Rule |
|------|----------|--------------|
| `docs/assets/demo-calculator.gif` | Native macOS Calculator control | Real system app, no personal data |
| `docs/assets/demo-background-safari-notes.gif` | Background Safari + Notes workflow while the user keeps typing elsewhere | Synthetic public data only |
| `docs/assets/demo-feishu-lark.gif` | Feishu/Lark best-effort enterprise app workflow | Sanitized test workspace with fake contacts and messages only |

Do not publish raw Feishu/Lark recordings that contain real chats, contacts, company names, or document titles. If a real Feishu/Lark recording is needed, use a dedicated test workspace such as `OpenClaudex Demo` and verify sampled frames before committing the GIF.

## Hero Demo: Safari + Notes

**What it shows**: End-to-end background automation across two native apps. Search the web, extract information, write it to Notes — all without touching the mouse or switching windows.

**Prerequisite**: Safari and Notes are open (not minimized).

### Demo Prompt

```
Using only Claudex Computer Use tools, complete this task entirely in the background:

1. Open Safari and search Google for "population of Tokyo"
2. Read the search result
3. Calculate Tokyo's population as a percentage of 8.1 billion world population
4. Open Notes and create a new note with the result
5. Report back what you wrote

Do not use web search tools. Do not bring any app to the foreground.
```

### Expected Flow

1. `get_app_state(app="Safari")` — snapshot Safari
2. `press_key(app="Safari", key="super+l")` — focus address bar
3. `get_app_state(app="Safari")` — re-snapshot after mutation
4. `type_text(app="Safari", text="population of Tokyo", strategy="pasteboard")` — enter query
5. `press_key(app="Safari", key="Return")` — submit search
6. `get_app_state(app="Safari")` — read results page
7. (Agent extracts population figure and calculates percentage)
8. `get_app_state(app="Notes")` — snapshot Notes
9. `set_value(app="Notes", element_index=<text_area>, value="Tokyo population: ...")` — write result
10. Report back

### Key Techniques Demonstrated

- `press_key` for keyboard shortcuts (cmd+l for address bar)
- `type_text` with pasteboard strategy for reliable text entry
- `set_value` for direct AX value writing (most reliable for Notes)
- Cross-app workflow without focus switching
- Snapshot-invalidate-re-snapshot cycle

---

## Demo 2: Calculator

**What it shows**: Pure AX-action workflow with semantic element IDs. No coordinates, no typing — just element_index clicks.

**Prerequisite**: Calculator is open.

### Demo Prompt

```
Using Claudex Computer Use, calculate 42 * 17 in the Calculator app.
Then read the result and tell me the answer.
```

### Expected Flow

1. `get_app_state(app="Calculator")` — snapshot Calculator
2. `click(app="Calculator", element_index=<AllClear>)` — clear
3. `get_app_state(app="Calculator")` — re-snapshot
4. `click(app="Calculator", element_index=<4>)` — press 4
5. ... continue with 2, *, 1, 7, =
6. `get_app_state(app="Calculator")` — read result display

### Key Techniques Demonstrated

- Pure element_index interaction via AXPress
- Semantic element IDs (no coordinate guessing)
- Sequential snapshot-click-snapshot pattern

---

## Demo 3: TextEdit Document

**What it shows**: Creating and editing a document using set_value.

**Prerequisite**: TextEdit is open with a blank document.

### Demo Prompt

```
Using Claudex Computer Use, write a short poem about AI into the open TextEdit document.
```

### Expected Flow

1. `get_app_state(app="TextEdit")` — find the text area element
2. `set_value(app="TextEdit", element_index=<text_area>, value="...")` — write the poem
3. `get_app_state(app="TextEdit")` — verify it was written

---

## Demo 4: Finder Navigation

**What it shows**: File system navigation using keyboard shortcuts and AX elements.

**Prerequisite**: Finder is open.

### Demo Prompt

```
Using Claudex Computer Use, navigate Finder to /tmp and list the files there.
```

### Expected Flow

1. `get_app_state(app="Finder")` — snapshot Finder
2. `press_key(app="Finder", key="super+shift+g")` — open Go To Folder
3. `get_app_state(app="Finder")` — snapshot the sheet
4. `type_text(app="Finder", text="/tmp")` — enter path
5. `press_key(app="Finder", key="Return")` — confirm
6. `get_app_state(app="Finder")` — read the file listing

---

## Demo 5: System Settings Exploration

**What it shows**: Navigating native macOS UI with deep AX trees.

**Prerequisite**: System Settings is open.

### Demo Prompt

```
Using Claudex Computer Use, open System Settings and tell me what macOS version is installed.
Check the "About This Mac" or "General > About" section.
```

---

## Internal Validation Prompts

These are not for external demos. Use them to verify Claudex Computer Use is working correctly.

### Permission Check

```
Call the Claudex Computer Use doctor tool and report the permission status.
```

### App Discovery

```
Use Claudex Computer Use to list all running apps and tell me which ones are running.
```

### Snapshot Cycle

```
Use get_app_state on Safari, click any element, then get_app_state again.
Confirm the snapshot was invalidated and refreshed.
```

### Type Text Strategies

```
Open TextEdit with a blank document. Try typing "Hello World" using:
1. set_value (direct AX write)
2. type_text with strategy=unicodeEvent
3. type_text with strategy=pasteboard

Report which methods succeeded.
```

### Cross-App Workflow

```
Use Claudex Computer Use to:
1. Read the current URL from Safari's address bar
2. Write that URL into a Notes document
Do everything in the background.
```

---

## Recording Script

For creating demo videos with the virtual cursor overlay visible:

```bash
# 1. Build
swift build

# 2. Start the MCP server (in one terminal)
./.build/debug/claudex-computer-use

# 3. Enable desktop overlay before running the demo
# Send this MCP call:
# set_virtual_cursor(preset="codexDemo", clear=true)
#
# This uses the same-process desktop overlay and keeps the live cursor trail-free.
# Screenshot trails remain available through debugTrace / crosshair when needed.

# 4. Run your demo via Claude Code or your MCP client
```

### Virtual Cursor Modes

| Mode | Screenshot | Desktop | Use Case |
|------|-----------|---------|----------|
| `off` | No | No | Production use, no visual feedback |
| `screenshotOverlay` | Yes | No | Screenshot-only annotations and trail debugging |
| `desktopOverlay` | No | Yes | Live same-process cursor for observation |
| `hybrid` | Yes | Yes | Default. Best for demo recordings |

### Virtual Cursor Styles

| Style | Look | Use Case |
|------|------|----------|
| `ghostArrow` | Codex-like blue-gray arrow with soft glow | Default demos and screen recordings |
| `secondCursor` | Dark alternate pointer with the same motion model | Side-by-side comparison / legacy demos |
| `crosshair` | Legacy crosshair/debug marker | Diagnostics and low-level verification |
