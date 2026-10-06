# Unreleased

- Fix Codex 0.160.0 conversations failing with "Runtime 尚未載入 Mac 工具；請重新連線。" after reconnecting and resuming an unloaded thread. Before starting a turn, verify the current Mac route on an ephemeral thread when the resumed thread has no selected environment, then release that probe and explicitly bind the original turn to this Mac.
- Apply the same verification to background discussion turns. Foreign environments, exposed remote tools, failed Mac tools and unverifiable environment selections still block inference.
- This source fix requires a rebuilt App. The existing 0.4.7 Release DMG is unchanged.

# 0.4.7

- Self-contained Apple Silicon DMG: Electron/Node, Codex 0.160.0 executor, native computer helpers and version-matched browser.
- All browser launch paths use the bundled executable. No Chrome install or first-launch browser download.
- Default optional HTTP MCP exposure is local-only; explicit Tailnet exposure remains supported. Unauthenticated LAN/public exposure stays blocked.
- Existing provider preferences and user data remain local and unchanged.
- Public source packaging excludes private machine evidence, reference notes, dependencies and build outputs.
- README, installation instructions, third-party notices, reproducible build steps and GitHub draft release workflow.

The locally built DMG is ad-hoc signed and not Apple notarized. The repository also includes an opt-in Developer ID and notarization build path; its success must be verified using actual maintainer credentials before claiming a notarized release.
