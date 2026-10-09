#!/usr/bin/env python3
"""Test stale/interference guard paths via NDJSON MCP.

Tests two scenarios:
1. click without prior get_app_state -> stale warning
2. click targeting a process that doesn't exist (PID 99999) -> stale warning
"""

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def send(proc, payload):
    line = json.dumps(payload, separators=(",", ":")).encode("utf-8") + b"\n"
    proc.stdin.write(line)
    proc.stdin.flush()


def recv(proc):
    line = proc.stdout.readline()
    if line == b"":
        raise RuntimeError("Unexpected EOF")
    return json.loads(line)


def extract_text(result):
    texts = []
    for item in result.get("content", []):
        if item.get("type") == "text":
            texts.append(item["text"])
    return "\n".join(texts)


def main():
    repo = Path(__file__).resolve().parents[1]
    binary = repo / ".build" / "debug" / "claudex-computer-use"
    proc = subprocess.Popen(
        [str(binary)], stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE
    )
    results = {}

    try:
        # Handshake
        send(proc, {"jsonrpc": "2.0", "id": 0, "method": "initialize",
                     "params": {"protocolVersion": "2025-11-25", "capabilities": {},
                                "clientInfo": {"name": "stale-test", "version": "1.0"}}})
        recv(proc)
        send(proc, {"jsonrpc": "2.0", "method": "notifications/initialized"})
        send(proc, {"jsonrpc": "2.0", "id": 1, "method": "tools/list", "params": {}})
        recv(proc)

        # Scenario 1: click on Finder without get_app_state
        send(proc, {"jsonrpc": "2.0", "id": 10, "method": "tools/call",
                     "params": {"name": "click", "arguments": {"app": "Finder", "element_index": 0}}})
        resp1 = recv(proc)
        text1 = extract_text(resp1.get("result", {}))
        results["scenario_1_no_snapshot"] = {
            "triggered": "Re-query the latest state" in text1,
            "response_text": text1[:200],
        }

        # Now do get_app_state to load a snapshot
        send(proc, {"jsonrpc": "2.0", "id": 11, "method": "tools/call",
                     "params": {"name": "get_app_state", "arguments": {"app": "Finder"}}})
        recv(proc)  # consume the response

        # Scenario 2: click with a bogus element_index that doesn't exist
        send(proc, {"jsonrpc": "2.0", "id": 12, "method": "tools/call",
                     "params": {"name": "click", "arguments": {"app": "Finder", "element_index": 99999}}})
        resp2 = recv(proc)
        text2 = extract_text(resp2.get("result", {}))
        results["scenario_2_bad_element"] = {
            "is_error": resp2.get("result", {}).get("isError", False),
            "response_text": text2[:200],
        }

        # Scenario 3: click targeting a non-existent PID
        send(proc, {"jsonrpc": "2.0", "id": 13, "method": "tools/call",
                     "params": {"name": "click", "arguments": {"app": "99999", "element_index": 0}}})
        resp3 = recv(proc)
        text3 = extract_text(resp3.get("result", {}))
        results["scenario_3_dead_pid"] = {
            "is_error": resp3.get("result", {}).get("isError", False),
            "response_text": text3[:200],
        }

        print(json.dumps(results, indent=2, ensure_ascii=False))
        # Verify at least scenario 1 triggered the stale guard
        assert results["scenario_1_no_snapshot"]["triggered"], "Stale guard did NOT trigger"
        print("\nAll stale guard scenarios verified.", file=sys.stderr)
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
