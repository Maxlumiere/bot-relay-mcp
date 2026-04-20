#!/usr/bin/env python3
"""
bot-relay-mcp: Managed Agent reference implementation (Python, stdlib-only).

This is a TEACHING script — ~200 lines that demonstrate the full relay
protocol from a non-Claude-Code agent's perspective. Read it top to bottom
to learn how to build your own Managed Agent in any language.

Production agents should add: structured logging, retry-with-backoff,
config files, metrics, health-check endpoints. This script intentionally
omits those to keep the protocol visible.

Usage:
    # 1. Start the relay in HTTP mode:
    RELAY_TRANSPORT=http node /path/to/bot-relay-mcp/dist/index.js

    # 2. Run this script:
    RELAY_HTTP_HOST=127.0.0.1 RELAY_HTTP_PORT=3777 python3 agent.py

    # 3. From another terminal, send a message:
    #    (use the relay dashboard at http://127.0.0.1:3777/ or the MCP tools)

Environment variables:
    RELAY_HTTP_HOST  — relay hostname (default: 127.0.0.1)
    RELAY_HTTP_PORT  — relay port (default: 3777)
    RELAY_AGENT_NAME — this agent's name (default: managed-py)
    RELAY_AGENT_ROLE — this agent's role (default: worker)
    RELAY_AGENT_TOKEN — saved token from a previous registration (optional)
"""
import http.client
import json
import os
import re
import signal
import sys
import time

# --- Configuration from environment ---

HOST = os.environ.get("RELAY_HTTP_HOST", "127.0.0.1")
PORT = int(os.environ.get("RELAY_HTTP_PORT", "3777"))
NAME = os.environ.get("RELAY_AGENT_NAME", "managed-py")
ROLE = os.environ.get("RELAY_AGENT_ROLE", "worker")
CAPABILITIES = os.environ.get("RELAY_AGENT_CAPABILITIES", "tasks,webhooks").split(",")
TOKEN = os.environ.get("RELAY_AGENT_TOKEN", "")
POLL_INTERVAL = int(os.environ.get("RELAY_POLL_INTERVAL", "5"))

# v2.1 Phase 4b.2: this reference agent registers with managed=true so it
# can receive push-token messages via the token_rotated event. Persisted
# credentials live at TOKEN_STORE_PATH (a local file in this demo; real
# deployments should use their platform's secrets manager).
TOKEN_STORE_PATH = os.environ.get(
    "RELAY_AGENT_TOKEN_STORE",
    os.path.join(os.path.dirname(os.path.abspath(__file__)), ".agent-token"),
)

# --- JSON-RPC helper ---

def rpc(tool_name: str, arguments: dict) -> dict:
    """Call a relay MCP tool via HTTP JSON-RPC. Returns the parsed inner result."""
    if TOKEN:
        arguments["agent_token"] = TOKEN
    payload = json.dumps({
        "jsonrpc": "2.0", "id": 1,
        "method": "tools/call",
        "params": {"name": tool_name, "arguments": arguments},
    })
    headers = {
        "Content-Type": "application/json",
        "Accept": "application/json, text/event-stream",
    }
    if TOKEN:
        headers["X-Agent-Token"] = TOKEN

    conn = http.client.HTTPConnection(HOST, PORT, timeout=10)
    try:
        conn.request("POST", "/mcp", body=payload, headers=headers)
        resp = conn.getresponse()
        raw = resp.read().decode("utf-8")
    finally:
        conn.close()

    # Response is SSE-framed: "event: message\ndata: {...}\n"
    # Extract the data: line.
    data_json = None
    for line in raw.splitlines():
        line = line.strip()
        if line.startswith("data:"):
            data_json = line[5:].strip()
            break
    if data_json is None:
        data_json = raw  # fallback: plain JSON (non-SSE)

    rpc_result = json.loads(data_json)
    inner_text = rpc_result["result"]["content"][0]["text"]
    return json.loads(inner_text)

# --- Registration ---

def register() -> str:
    """Register this agent. Returns the token (new or existing)."""
    global TOKEN
    if TOKEN:
        # Already have a token from a previous run — re-register to refresh
        # last_seen. Caps are immutable (v1.7.1) so they won't change.
        result = rpc("register_agent", {
            "name": NAME, "role": ROLE, "capabilities": CAPABILITIES,
            # managed=true is immutable after first register; sending it again
            # is harmless (preserved) but signals intent on the dashboard.
            "managed": True,
        })
        print(f"[{NAME}] Re-registered (last_seen refreshed).", file=sys.stderr)
        return TOKEN

    # First-time registration — no token needed (bootstrap path). Flag
    # `managed: True` so the relay routes token_rotated push-messages to us
    # and gives us a grace window on rotate_token instead of immediate cut.
    result = rpc("register_agent", {
        "name": NAME, "role": ROLE, "capabilities": CAPABILITIES,
        "managed": True,
    })
    if not result.get("success"):
        print(f"[{NAME}] Registration failed: {result.get('error')}", file=sys.stderr)
        sys.exit(1)

    new_token = result.get("agent_token", "")
    if new_token:
        TOKEN = new_token
        persist_token(TOKEN)
        print(f"[{NAME}] Registered as managed. Token persisted to {TOKEN_STORE_PATH}.", file=sys.stderr)
    return TOKEN


# --- Token persistence (v2.1 Phase 4b.2) ---

def persist_token(token: str) -> None:
    """Atomically write the current agent_token to TOKEN_STORE_PATH.
    Must complete BEFORE any ack of a token_rotated event; otherwise a
    crash between read-from-message and write-to-disk leaves the agent
    with a stale token on next restart. See docs/managed-agent-protocol.md
    §Persist-before-ack."""
    tmp_path = TOKEN_STORE_PATH + ".tmp"
    # 0600 — token is sensitive; match the relay's own file-perm discipline
    # (Phase 4c.4).
    fd = os.open(tmp_path, os.O_WRONLY | os.O_CREAT | os.O_TRUNC, 0o600)
    try:
        os.write(fd, token.encode("utf-8"))
        os.fsync(fd)
    finally:
        os.close(fd)
    os.replace(tmp_path, TOKEN_STORE_PATH)  # atomic on POSIX


def load_persisted_token() -> str:
    """Best-effort load on startup. Returns empty string if no store exists."""
    try:
        with open(TOKEN_STORE_PATH, "r", encoding="utf-8") as f:
            return f.read().strip()
    except FileNotFoundError:
        return ""


# Hydrate TOKEN from persisted store if env didn't supply one — survives
# restart after a prior rotation.
if not TOKEN:
    persisted = load_persisted_token()
    if persisted:
        TOKEN = persisted
        print(f"[{NAME}] Restored token from {TOKEN_STORE_PATH}.", file=sys.stderr)


# --- v2.1 Phase 4b.2: token-rotation push-message handler ---

PROTOCOL_FENCE_RE = re.compile(r"```json\n(.*?)\n```", re.DOTALL)


def parse_protocol_payload(message_content: str):
    """Extract the fenced JSON block from a protocol message, if any."""
    m = PROTOCOL_FENCE_RE.search(message_content)
    if not m:
        return None
    try:
        return json.loads(m.group(1))
    except json.JSONDecodeError:
        return None


def handle_token_rotation(payload: dict) -> bool:
    """Process a token_rotated event. Returns True if handled.

    Persist-before-ack: the new token is written to TOKEN_STORE_PATH BEFORE
    the in-memory TOKEN is updated. If this process crashes between the
    two, the next startup loads the new token from disk and reconnects
    cleanly. Mirrors the Phase 4o recovery-flow persist discipline.
    """
    global TOKEN
    new_token = payload.get("new_token")
    grace_expires_at = payload.get("grace_expires_at")
    rotator = payload.get("rotator", "?")
    if not isinstance(new_token, str) or not new_token:
        print(f"[{NAME}] token_rotated payload missing new_token — ignoring.", file=sys.stderr)
        return False

    # 1. Persist FIRST. If this throws, we never update the in-memory token,
    #    so the agent keeps using the old token (still valid during grace)
    #    and a future retry of the message can re-run the handler.
    try:
        persist_token(new_token)
    except Exception as e:
        print(f"[{NAME}] persist failed; will retry on next poll: {e}", file=sys.stderr)
        return False

    # 2. Cut over in-process. All subsequent RPCs use the new token.
    TOKEN = new_token
    print(
        f"[{NAME}] Token rotated by \"{rotator}\". Persisted + cut over. "
        f"Old token valid until {grace_expires_at}.",
        file=sys.stderr,
    )
    return True

# --- Unregister (clean shutdown) ---

def unregister():
    """Remove ourselves from the relay so peers stop routing to us."""
    try:
        result = rpc("unregister_agent", {"name": NAME})
        removed = result.get("removed", False)
        print(f"[{NAME}] Unregistered (removed={removed}).", file=sys.stderr)
    except Exception as e:
        print(f"[{NAME}] Unregister failed (non-fatal): {e}", file=sys.stderr)

# --- Signal handlers for clean shutdown ---

def shutdown_and_exit(signum=None, frame=None):
    print(f"\n[{NAME}] Shutting down (signal {signum})...", file=sys.stderr)
    unregister()
    sys.exit(0)

signal.signal(signal.SIGINT, shutdown_and_exit)
signal.signal(signal.SIGTERM, shutdown_and_exit)

# --- Message handling ---

def check_messages():
    """Poll for pending messages and print them. Intercepts relay protocol
    messages (v2.1 Phase 4b.2+) and dispatches them to their handlers
    BEFORE surfacing to human-readable logging."""
    result = rpc("get_messages", {
        "agent_name": NAME, "status": "pending", "limit": 20,
    })
    messages = result.get("messages", [])
    for m in messages:
        frm = m.get("from_agent", "?")
        content = m.get("content", "")
        prio = m.get("priority", "normal")

        # v2.1 Phase 4b.2: intercept protocol envelopes first. The fenced
        # JSON block is parsed; if protocol matches, dispatch to the
        # matching handler BEFORE printing the raw message. Protocol
        # messages are system events, not human traffic.
        payload = parse_protocol_payload(content)
        if payload and payload.get("protocol") == "bot-relay-token-rotation":
            if payload.get("version") != 1:
                print(
                    f"[{NAME}] Unknown bot-relay-token-rotation version "
                    f"{payload.get('version')!r}; ignoring.",
                    file=sys.stderr,
                )
                continue
            if payload.get("event") == "token_rotated":
                handle_token_rotation(payload)
                continue
            # Unknown event within known protocol — log and skip.
            print(
                f"[{NAME}] Unknown bot-relay-token-rotation event "
                f"{payload.get('event')!r}; ignoring.",
                file=sys.stderr,
            )
            continue

        print(f"[{NAME}] Mail from {frm} [{prio}]: {content[:200]}", file=sys.stderr)
    return messages

# --- Task handling ---

def check_tasks():
    """Poll for posted tasks assigned to us, accept + complete them."""
    result = rpc("get_tasks", {
        "agent_name": NAME, "role": "assigned", "status": "posted",
    })
    tasks = result.get("tasks", [])
    for t in tasks:
        task_id = t["id"]
        title = t.get("title", "")
        frm = t.get("from_agent", "?")
        print(f"[{NAME}] Task from {frm}: {title} (id={task_id})", file=sys.stderr)

        # Accept the task
        rpc("update_task", {
            "task_id": task_id, "agent_name": NAME, "action": "accept",
        })
        print(f"[{NAME}] Accepted task {task_id}.", file=sys.stderr)

        # ... do real work here ...
        # For this reference, we immediately complete with a dummy result.

        rpc("update_task", {
            "task_id": task_id, "agent_name": NAME, "action": "complete",
            "result": f"Completed by {NAME} (reference agent).",
        })
        print(f"[{NAME}] Completed task {task_id}.", file=sys.stderr)
    return tasks

# --- Discover peers (optional, for debugging) ---

def discover():
    """Print the current agent roster."""
    result = rpc("discover_agents", {})
    agents = result.get("agents", [])
    names = [a["name"] for a in agents]
    print(f"[{NAME}] Peers: {', '.join(names) or '(none)'}", file=sys.stderr)
    return agents

# --- Main loop ---

def main():
    print(f"[{NAME}] Starting managed agent (host={HOST}:{PORT}, role={ROLE})", file=sys.stderr)
    register()
    discover()

    print(f"[{NAME}] Entering poll loop (interval={POLL_INTERVAL}s). Ctrl-C to quit.", file=sys.stderr)
    while True:
        try:
            check_messages()
            check_tasks()
        except KeyboardInterrupt:
            shutdown_and_exit()
        except Exception as e:
            print(f"[{NAME}] Poll error (will retry): {e}", file=sys.stderr)
        time.sleep(POLL_INTERVAL)

if __name__ == "__main__":
    main()
