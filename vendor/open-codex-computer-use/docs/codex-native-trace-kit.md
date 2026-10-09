# Codex Native Trace Kit

High-signal prompts for collecting **native Codex computer-use traces** on macOS.

This is **not** a Claudex Computer Use demo pack and **not** a product acceptance suite. The goal is to expose Codex's real external behavior so its contract and routing strategy can be reverse-engineered from local rollout traces.

Use this kit when you want to answer questions like:

- When does Codex refresh app state?
- Does it prefer element actions or coordinate clicks?
- How does it route text input in browsers vs native apps vs weak-AX apps?
- How does it describe failures in Electron / WebView-heavy apps?
- What behavior already matches Claudex Computer Use, and what still differs?

## Prerequisites

- Run each prompt in a **fresh Codex session**
- Keep the target app **open and not minimized**
- Avoid hand-assisting the session unless the prompt is explicitly testing interruption
- Record:
  - session id
  - original prompt
  - target app
  - outcome: success / partial / failure
  - any obvious user-visible behavior (focus flash, no-op click, wrong input, etc.)

For the current machine, the most reliable target apps are:

- Safari
- Google Chrome
- Microsoft Edge
- Notes
- TextEdit
- Calculator
- System Settings
- Codex.app
- Enterprise WeChat (`企业微信`)

## Recommended Run Order

If time is limited, run these six first:

1. Safari current-page read
2. Safari scroll then re-read
3. Notes create note
4. TextEdit write document
5. Enterprise WeChat open search
6. Enterprise WeChat search fixed string

That set gives the best coverage of read-only state capture, mutation -> re-snapshot behavior, semantic text entry, and weak-AX failure modes.

## Single-Capability Prompts

### 1. Safari Current Page Read

```text
Using only computer-use, inspect the page that is currently open in Safari.
Tell me:
1. the current window title
2. the current URL
3. what the page is mainly about
Do not open a new tab and do not navigate away.
```

Purpose: expose read-only page capture, URL extraction, and visible content fidelity.

### 2. Safari Scroll Then Re-Read

```text
Using only computer-use, inspect the page currently open in Safari, scroll down by about two screens, and then tell me what is now visible around the middle of the page.
Do not switch tabs and do not visit a new page.
```

Purpose: expose scroll routing and whether Codex refreshes state after mutation.

### 3. Chrome Current Page Read

```text
Using only computer-use, inspect the current tab in Google Chrome.
Tell me the window title, what the page is mainly about, and the most obvious interactive element you can see.
Do not navigate anywhere.
```

Purpose: compare Safari and Chromium-family read behavior.

### 4. Edge Scroll And Summarize

```text
Using only computer-use, inspect the current page in Microsoft Edge, scroll down by one screen, and then summarize what is visible in the current viewport in 3 short sentences.
Do not open a different page.
```

Purpose: compare Chromium-family behavior across two browsers.

### 5. Notes Create Note

```text
Using only computer-use, open Notes, create a new note, set the title to:
Claudex Computer Use Demo
and set the body to:
AX-first background automation
Then tell me whether the note was actually created and repeat back the title and body you can see.
```

Purpose: expose whether Codex uses semantic text/value setting on native AppKit text controls.

### 6. TextEdit Write Document

```text
Using only computer-use, open TextEdit, create a blank document, and write this exact sentence:
Claudex Computer Use background typing test
Then read back the visible text in the document.
```

Purpose: compare text entry behavior between Notes and TextEdit.

### 7. Calculator Arithmetic

```text
Using only computer-use, open Calculator and compute:
14150000 / 8100000000 * 100
Do not calculate it in another app.
Tell me the final value shown in Calculator.
```

Purpose: expose pure element-click or semantic-action routing without freeform text.

### 8. System Settings Keyboard Page

```text
Using only computer-use, open System Settings, find the Keyboard-related settings, and stop on that page.
Then tell me the page title and the currently selected item in the left sidebar.
```

Purpose: expose deep native AX navigation and sidebar interactions.

### 9. Codex.app Window Read

```text
Using only computer-use, inspect the current Codex.app window.
Tell me the 3 most prominent readable texts or control labels you can identify.
Do not click anything.
```

Purpose: expose how well Codex can read its own UI without self-modifying the session.

### 10. Enterprise WeChat Open Search

```text
Using only computer-use, open the search UI in 企业微信 and stop when the search field is ready for input.
Do not type anything.
Then tell me whether the search UI actually opened.
If it failed, be specific about whether it failed on the shortcut, focus, or UI readability.
```

Purpose: isolate shortcut delivery, focus acquisition, and weak-AX visibility.

### 11. Enterprise WeChat Search Fixed String

```text
Using only computer-use, open search in 企业微信, type:
abc123_test_query
and stop without opening any conversation.
Then tell me exactly what text ended up in the search field.
If it failed, say whether the problem was focus, input delivery, IME interference, or unreadable results.
```

Purpose: expose text input routing and IME/focus failure modes in a weak-AX app.

## Multi-Step Chain Prompts

### 12. Safari Interaction Chain

```text
Using only computer-use, do these steps in Safari:
1. inspect the current page and understand what it is about
2. click one interactive element that looks safe
3. scroll down by one screen
4. tell me what changed on the page
Do not open a different website.
```

Purpose: expose continuous mutation -> refresh -> mutation behavior.

### 13. Browser Search Chain

```text
Using only computer-use, in the current Chrome or Edge window, focus the address bar or search field, type:
claudex-computer-use mcp
and stop on the suggestions list or results page.
Then tell me whether the input really landed and whether the page or suggestion area changed.
Do not continue to open any result.
```

Purpose: expose browser text-entry strategy and submission behavior.

### 14. Enterprise WeChat Boundary Chain

```text
Using only computer-use, do these three steps in 企业微信:
1. open search
2. type:
Test User
3. stop on the result list
Do not send a message and do not open any conversation.
If this fails, report step by step whether the failure happened while opening search, delivering text input, or refreshing the result list.
```

Purpose: expose stepwise failure classification in a weak-AX app.

## What To Look For During Analysis

When you later inspect the rollout trace, answer these questions:

- **State refresh**
  - Does Codex re-capture state before every mutation?
  - Does it treat post-mutation state as stale by default?
- **Click routing**
  - Does it prefer indexed/semantic actions first?
  - When does it fall back to coordinates?
- **Input routing**
  - Do browsers, AppKit text fields, and Enterprise WeChat use different strategies?
  - Does failure language suggest keyboard injection, direct value setting, or clipboard-like fallback?
- **Failure taxonomy**
  - Can failures be separated into shortcut/focus/input/AX-tree/result-refresh buckets?
- **App-family differences**
  - Does Safari behave differently from Chrome/Edge?
  - Does Enterprise WeChat fail in the same way as known weak-AX open-source examples?

## Suggested Metadata Template

Use this per prompt so later trace analysis is clean:

```text
Prompt:
Session ID:
Target app:
Outcome: success / partial / failure
Visible behavior:
Notes:
```

Failure is still a useful sample. A cleanly-explained failure is often more informative than a shallow success.
