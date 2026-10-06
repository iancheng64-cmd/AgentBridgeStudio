# Architecture

AgentBridge Studio is an Electron macOS client. A selected remote Codex App Server or Claude Code Runtime owns provider authentication and model requests. Local tools execute on the user's Mac.

```text
Mac UI ── SSH ── remote authenticated Runtime ── model provider
   │                       │
   └── local executor ◀────┘
          ├── files / shell (selected Mac workspace)
          ├── native Computer Use (bundled Swift MCP)
          └── browser (bundled Playwright + browser distribution)
```

The App contains Electron/Node, the paired Codex executor, native Computer Use helpers, JavaScript MCP packages and a version-matched browser. There is no first-launch package or browser installation. Build-time downloads are separate.

New users default to bundled Computer Use and loopback-only optional HTTP MCP. Existing explicit external Computer Use settings are preserved; failure never silently changes the provider. HTTP service status requires MCP handshake and a read-only tool call, not merely an open socket.

Remote Codex versions remain paired with verified local executor versions. A broken local execution path must not silently route user work to the remote host. First-use SSH trust requires fingerprint confirmation. ChatGPT/Claude tokens are not packaged or copied from the remote host.

Application data, profiles, encrypted credential envelopes, chat history, library files and browser profiles are user-local, never part of a release. Native OS permissions are distinct from App tool approval modes. A workspace path is not an OS-wide shell or GUI sandbox.
