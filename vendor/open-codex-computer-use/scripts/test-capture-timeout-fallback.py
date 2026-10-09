#!/usr/bin/env python3

from __future__ import annotations

import json
import select
import subprocess
import sys
import time
from pathlib import Path


REPO = Path(__file__).resolve().parents[1]
SERVER = REPO / ".build" / "debug" / "claudex-computer-use"


class MCPClient:
    def __init__(self) -> None:
        self.proc = subprocess.Popen(
            [str(SERVER)],
            cwd=REPO,
            stdin=subprocess.PIPE,
            stdout=subprocess.PIPE,
            stderr=subprocess.PIPE,
        )
        self._id = 0
        self._initialize()

    def _initialize(self) -> None:
        self._send({
            "jsonrpc": "2.0",
            "id": 1,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-03-26",
                "capabilities": {},
                "clientInfo": {"name": "capture-timeout-test", "version": "1.0"},
            },
        })
        self._recv(timeout=5)
        self._send({
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
            "params": {},
        })

    def _send(self, payload: dict) -> None:
        body = json.dumps(payload).encode("utf-8")
        header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
        assert self.proc.stdin is not None
        self.proc.stdin.write(header)
        self.proc.stdin.write(body)
        self.proc.stdin.flush()

    def _recv(self, timeout: float) -> dict:
        assert self.proc.stdout is not None
        deadline = time.time() + timeout
        while time.time() < deadline:
            ready, _, _ = select.select([self.proc.stdout], [], [], 0.2)
            if ready:
                break
        else:
            raise TimeoutError(f"Timed out after {timeout:.1f}s waiting for MCP response.")

        content_length = None
        while True:
            line = self.proc.stdout.readline()
            if line == b"":
                raise RuntimeError("Unexpected EOF from MCP server.")
            if line in {b"\r\n", b"\n"}:
                break
            header = line.decode("utf-8").strip()
            if header.lower().startswith("content-length:"):
                content_length = int(header.split(":", 1)[1].strip())

        if content_length is None:
            raise RuntimeError("Missing Content-Length header in MCP response.")

        body = self.proc.stdout.read(content_length)
        return json.loads(body.decode("utf-8"))

    def call(self, tool: str, arguments: dict, timeout: float = 10.0) -> tuple[dict, float]:
        self._id += 1
        started = time.time()
        self._send({
            "jsonrpc": "2.0",
            "id": self._id,
            "method": "tools/call",
            "params": {"name": tool, "arguments": arguments},
        })
        response = self._recv(timeout=timeout)
        return response, time.time() - started

    def close(self) -> None:
        self.proc.terminate()
        try:
            self.proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            self.proc.kill()
            self.proc.wait(timeout=2)


def main() -> int:
    app_name = sys.argv[1] if len(sys.argv) > 1 else "Calculator"
    if not SERVER.exists():
        print("Build first: swift build", file=sys.stderr)
        return 1

    client = MCPClient()
    try:
        apps_resp, _ = client.call("list_apps", {}, timeout=5)
        apps = apps_resp["result"]["structuredContent"]["apps"]
        matches = [
            app for app in apps
            if app_name.lower() in (app.get("localizedName", "") + " " + (app.get("bundleIdentifier") or "")).lower()
        ]
        if not matches:
            print(json.dumps({"error": f"App not running: {app_name}"}, ensure_ascii=False, indent=2))
            return 1

        pid = matches[0]["pid"]

        list_windows_resp, list_windows_s = client.call("list_windows", {"pid": pid}, timeout=5)
        windows = list_windows_resp["result"]["structuredContent"]["windows"]
        if not windows:
            print(json.dumps({"error": "No windows found", "pid": pid}, ensure_ascii=False, indent=2))
            return 1

        capture_resp, capture_s = client.call("capture_window", {"pid": pid}, timeout=8)
        capture_meta = capture_resp["result"]["structuredContent"]

        app_state_resp, app_state_s = client.call("get_app_state", {"app": app_name}, timeout=8)
        app_state = app_state_resp["result"]["structuredContent"]

        print(json.dumps({
            "app": app_name,
            "pid": pid,
            "list_windows_s": round(list_windows_s, 2),
            "capture_window_s": round(capture_s, 2),
            "get_app_state_s": round(app_state_s, 2),
            "window_count": len(windows),
            "capture_backend": capture_meta.get("captureBackend"),
            "capture_size": [capture_meta.get("pixelWidth"), capture_meta.get("pixelHeight")],
            "element_count": app_state["snapshot"]["elementCount"],
            "app_state_screenshot_backend": app_state["screenshot"]["captureBackend"] if app_state.get("screenshot") else None,
        }, ensure_ascii=False, indent=2))
        return 0
    finally:
        client.close()


if __name__ == "__main__":
    raise SystemExit(main())
