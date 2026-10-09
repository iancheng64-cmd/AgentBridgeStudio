#!/usr/bin/env python3
"""Smoke test using NDJSON framing (MCP SDK >= 2025-11-25).

Mirrors smoke-mcp.py but uses newline-delimited JSON instead of Content-Length
framing. This is the protocol that Claude Code 2.1.77+ actually speaks.
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def send_ndjson(proc: subprocess.Popen[bytes], payload: dict) -> None:
    line = json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"
    assert proc.stdin is not None
    proc.stdin.write(line)
    proc.stdin.flush()


def read_ndjson(proc: subprocess.Popen[bytes]) -> dict:
    assert proc.stdout is not None
    line = proc.stdout.readline()
    if line == b"":
        raise RuntimeError("Unexpected EOF while waiting for NDJSON response.")
    return json.loads(line)


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    server_path = repo_root / ".build" / "debug" / "claudex-computer-use"
    if not server_path.exists():
        print("Build first: swift build", file=sys.stderr)
        return 1

    proc = subprocess.Popen(
        [str(server_path)],
        cwd=repo_root,
        stdin=subprocess.PIPE,
        stdout=subprocess.PIPE,
        stderr=subprocess.PIPE,
    )

    try:
        # 1. initialize
        send_ndjson(proc, {
            "jsonrpc": "2.0",
            "id": 0,
            "method": "initialize",
            "params": {
                "protocolVersion": "2025-11-25",
                "capabilities": {"roots": {}},
                "clientInfo": {"name": "smoke-ndjson", "version": "1.0.0"},
            },
        })
        init_resp = read_ndjson(proc)
        server_info = init_resp.get("result", {}).get("serverInfo", {})
        assert server_info.get("name") == "claudex-computer-use", f"Bad serverInfo: {server_info}"

        # 2. notifications/initialized
        send_ndjson(proc, {
            "jsonrpc": "2.0",
            "method": "notifications/initialized",
        })

        # 3. tools/list
        send_ndjson(proc, {
            "jsonrpc": "2.0",
            "id": 1,
            "method": "tools/list",
            "params": {},
        })
        tools_resp = read_ndjson(proc)
        tools = tools_resp.get("result", {}).get("tools", [])
        tool_names = sorted(t["name"] for t in tools)
        assert len(tool_names) == 23, f"Expected 23 tools, got {len(tool_names)}: {tool_names}"

        # 4. tools/call doctor
        send_ndjson(proc, {
            "jsonrpc": "2.0",
            "id": 2,
            "method": "tools/call",
            "params": {"name": "doctor", "arguments": {}},
        })
        doctor_resp = read_ndjson(proc)
        doctor_result = doctor_resp.get("result", {})
        structured = doctor_result.get("structuredContent", {})
        assert "version" in structured, f"doctor missing version: {structured}"
        assert structured.get("permissions", {}).get("accessibilityTrusted") is True, \
            f"Accessibility not granted: {structured}"

        # 5. stale guard: click without prior get_app_state -> should error with stale message
        send_ndjson(proc, {
            "jsonrpc": "2.0",
            "id": 3,
            "method": "tools/call",
            "params": {"name": "click", "arguments": {"app": "Finder", "element_index": 0}},
        })
        stale_resp = read_ndjson(proc)
        stale_result = stale_resp.get("result", {})
        stale_text = ""
        for item in stale_result.get("content", []):
            if item.get("type") == "text":
                stale_text += item["text"]
        assert "Re-query the latest state" in stale_text, \
            f"Expected stale warning, got: {stale_text}"

        print(json.dumps({
            "framing": "NDJSON",
            "protocol_version": "2025-11-25",
            "server_info": server_info,
            "tool_count": len(tool_names),
            "tools": tool_names,
            "doctor_version": structured.get("version"),
            "stale_guard_triggered": True,
        }, indent=2, sort_keys=True))
        return 0

    finally:
        proc.terminate()
        try:
            proc.wait(timeout=2)
        except subprocess.TimeoutExpired:
            proc.kill()
            proc.wait(timeout=2)


if __name__ == "__main__":
    raise SystemExit(main())
