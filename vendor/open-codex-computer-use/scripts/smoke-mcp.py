#!/usr/bin/env python3

from __future__ import annotations

import json
import subprocess
import sys
from pathlib import Path


def send_message(proc: subprocess.Popen[bytes], payload: dict) -> None:
    body = json.dumps(payload).encode("utf-8")
    header = f"Content-Length: {len(body)}\r\n\r\n".encode("utf-8")
    assert proc.stdin is not None
    proc.stdin.write(header)
    proc.stdin.write(body)
    proc.stdin.flush()


def read_message(proc: subprocess.Popen[bytes]) -> dict:
    assert proc.stdout is not None

    content_length = None
    while True:
        line = proc.stdout.readline()
        if line == b"":
            raise RuntimeError("Unexpected EOF while waiting for MCP response.")
        if line in {b"\r\n", b"\n"}:
            break
        header = line.decode("utf-8").strip()
        if header.lower().startswith("content-length:"):
            content_length = int(header.split(":", 1)[1].strip())

    if content_length is None:
        raise RuntimeError("Missing Content-Length header in MCP response.")

    body = proc.stdout.read(content_length)
    if len(body) != content_length:
        raise RuntimeError("Unexpected EOF while reading MCP body.")

    return json.loads(body.decode("utf-8"))


def main() -> int:
    repo_root = Path(__file__).resolve().parents[1]
    server_path = repo_root / ".build" / "debug" / "claudex-computer-use"
    expected_tools = {
        "acquire_desktop",
        "capture_window",
        "click",
        "desktop_status",
        "doctor",
        "drag",
        "find_ui_element",
        "get_allowlist",
        "get_app_state",
        "get_virtual_cursor",
        "list_apps",
        "list_windows",
        "perform_action",
        "perform_secondary_action",
        "press_element",
        "press_key",
        "release_desktop",
        "scroll",
        "set_allowlist",
        "set_value",
        "set_virtual_cursor",
        "stop",
        "type_text",
    }
    expected_schema_fields = {
        "acquire_desktop": {"mode", "action_budget", "app"},
        "click": {"app", "element_index", "x", "y", "click_count", "mouse_button"},
        "drag": {"app", "fromX", "fromY", "toX", "toY", "from_x", "from_y", "to_x", "to_y"},
        "press_key": {"app", "key", "delivery", "restore_focus"},
        "perform_secondary_action": {"app", "element_index", "action"},
        "set_value": {"app", "element_index", "pid", "windowIndex", "path", "value"},
        "set_virtual_cursor": {"preset", "mode", "style", "show_trail", "trail_limit", "max_age_seconds", "clear"},
        "type_text": {"app", "pid", "text", "strategy", "delivery", "restore_focus"},
    }
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
        send_message(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 1,
                "method": "initialize",
                "params": {
                    "protocolVersion": "2025-03-26",
                    "capabilities": {},
                    "clientInfo": {
                        "name": "claudex-computer-use-smoke",
                        "version": "0.1.0"
                    }
                }
            },
        )
        initialize_response = read_message(proc)

        send_message(
            proc,
            {
                "jsonrpc": "2.0",
                "method": "notifications/initialized",
                "params": {}
            },
        )

        send_message(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 2,
                "method": "tools/list",
                "params": {}
            },
        )
        tools_response = read_message(proc)

        send_message(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 3,
                "method": "tools/call",
                "params": {
                    "name": "doctor",
                    "arguments": {}
                }
            },
        )
        doctor_response = read_message(proc)

        send_message(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 4,
                "method": "tools/call",
                "params": {
                    "name": "desktop_status",
                    "arguments": {}
                }
            },
        )
        desktop_response = read_message(proc)

        send_message(
            proc,
            {
                "jsonrpc": "2.0",
                "id": 5,
                "method": "tools/call",
                "params": {
                    "name": "get_virtual_cursor",
                    "arguments": {}
                }
            },
        )
        virtual_cursor_response = read_message(proc)

        tools = tools_response["result"]["tools"]
        tool_map = {tool["name"]: tool for tool in tools}
        tool_names = sorted(tool["name"] for tool in tools)
        missing_tools = sorted(expected_tools - set(tool_names))
        if missing_tools:
            print(
                json.dumps(
                    {
                        "error": "missing expected MCP tools",
                        "missing_tools": missing_tools,
                        "tools": tool_names,
                    },
                    indent=2,
                    sort_keys=True,
                ),
                file=sys.stderr,
            )
            return 1
        schema_errors: dict[str, list[str]] = {}
        for tool_name, required_fields in expected_schema_fields.items():
            properties = tool_map[tool_name]["inputSchema"]["properties"]
            missing_fields = sorted(required_fields - set(properties))
            if missing_fields:
                schema_errors[tool_name] = missing_fields
        if schema_errors:
            print(
                json.dumps(
                    {
                        "error": "missing expected schema fields",
                        "schema_errors": schema_errors,
                    },
                    indent=2,
                    sort_keys=True,
                ),
                file=sys.stderr,
            )
            return 1
        print(
            json.dumps(
                    {
                        "doctor": doctor_response["result"]["structuredContent"],
                        "desktop_status": desktop_response["result"]["structuredContent"],
                        "initialize": initialize_response["result"]["serverInfo"],
                        "tool_count": len(tool_names),
                        "tools": tool_names,
                        "virtual_cursor": virtual_cursor_response["result"]["structuredContent"],
                    },
                    indent=2,
                    sort_keys=True,
                )
        )
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
