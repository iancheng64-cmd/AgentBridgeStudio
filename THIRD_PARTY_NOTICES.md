# Third-party components

AgentBridge's own source is MIT licensed. Bundled third-party components retain their original licenses and copyright notices; the application license does not replace them.

| Component | Upstream | License / notice |
| --- | --- | --- |
| Electron | https://github.com/electron/electron | MIT; Chromium notices included in the App |
| Codex CLI and executor 0.160.0 | https://github.com/openai/codex | Apache-2.0, `vendor/codex/LICENSE` |
| Native Computer Use | https://github.com/iFurySt/open-codex-computer-use | MIT, `vendor/open-codex-computer-use/LICENSE`; includes local modifications |
| Playwright and Playwright MCP | https://github.com/microsoft/playwright / https://github.com/microsoft/playwright-mcp | Apache-2.0 |
| Playwright browser distribution | https://playwright.dev/docs/browsers | Full browser distribution retained; `chrome://credits` provides its component credits |
| FFmpeg 7.0.1 supplied by Playwright (build 1011) | https://ffmpeg.org/releases/ffmpeg-7.0.1.tar.xz / https://ffmpeg.org/legal.html | LGPL-2.1-or-later; original license retained inside `browser/ffmpeg-1011/` |
| JavaScript dependencies | `package-lock.json` | Individual texts in `Contents/Resources/third-party-notices/NODE_DEPENDENCIES.md` |

The installed App includes `Contents/Resources/third-party-notices/` and the browser's embedded notices. Claude Code is not redistributed: this release connects to an installed remote Runtime.

AgentBridge is an independent project, not an official OpenAI, Anthropic, Google or Microsoft application. Use your own authorized account; entitlement and usage limits remain managed by the provider.
