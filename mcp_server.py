"""Keto tracker MCP server over stdio (JSON-RPC 2.0).

Reads Content-Length framed messages. If a client sends newline-delimited
JSON instead (as current MCP stdio clients do), replies use the same style.
stdout carries only protocol messages; all logging goes to stderr.
"""

import json
import sys

import db

SERVER_INFO = {"name": "keto", "version": "1.0.0"}
PROTOCOL_VERSIONS = ("2025-06-18", "2025-03-26", "2024-11-05")

_ENTRY_SCHEMA = {
    "type": "object",
    "properties": {
        "date": {"type": "string", "description": "DD/MM/YYYY. Default: today (Europe/Copenhagen)."},
        "time": {"type": "string", "description": "HH:MM, 24h."},
        "fasting_hours": {"type": "number", "description": "Only on the entry that breaks a fast."},
        "item": {"type": "string", "description": "Food name, stored verbatim (Hebrew is fine)."},
        "quantity": {"type": "string"},
        "calories": {"type": "number"},
        "fat_g": {"type": "number"},
        "protein_g": {"type": "number"},
        "net_carbs_g": {"type": "number", "description": "Required. 0 is allowed."},
        "notes": {"type": "string"},
        "meal": {"type": "string"},
    },
    "required": ["item", "net_carbs_g"],
    "additionalProperties": False,
}

_MOMENT_PROPS = {
    "date": {"type": "string", "description": "DD/MM/YYYY. Default: today (Europe/Copenhagen)."},
    "time": {"type": "string", "description": "HH:MM, 24h. Default: now."},
    "notes": {"type": "string"},
}

MEASURE_PROPS = {
    "date": {"type": "string", "description": "DD/MM/YYYY. Default: today (Europe/Copenhagen)."},
    "time": {"type": ["string", "null"], "description": "HH:MM, 24h."},
    "weight_kg": {"type": ["number", "null"]},
    "ketones_mmol": {"type": ["number", "null"], "description": "Blood ketones, mmol/L."},
    "glucose_mmol": {"type": ["number", "null"], "description": "Blood glucose, mmol/L."},
    "bp_sys": {"type": ["number", "null"], "description": "Systolic, mmHg."},
    "bp_dia": {"type": ["number", "null"], "description": "Diastolic, mmHg."},
    "pulse": {"type": ["number", "null"], "description": "Beats per minute."},
    "notes": {"type": ["string", "null"]},
}

TOOLS = [
    {
        "name": "add_entries",
        "description": "Add one or more rows to the keto log. Returns the created rows "
                       "and the day summary (totals, the day's net-carb goal, remaining, "
                       "over_goal) for each touched date.",
        "inputSchema": {
            "type": "object",
            "properties": {"entries": {"type": "array", "items": _ENTRY_SCHEMA, "minItems": 1}},
            "required": ["entries"],
        },
    },
    {
        "name": "get_day",
        "description": "Entries and totals for one day, fasts that ended that day, "
                       "and the running fast if any.",
        "inputSchema": {
            "type": "object",
            "properties": {"date": {"type": "string", "description": "DD/MM/YYYY. Default: today."}},
        },
    },
    {
        "name": "recent_days",
        "description": "One summary per logged day, newest first.",
        "inputSchema": {
            "type": "object",
            "properties": {"n": {"type": "integer", "minimum": 1, "maximum": 60, "default": 14}},
        },
    },
    {
        "name": "update_entry",
        "description": "Change fields of one entry by id. Omitted fields keep their value; "
                       "null clears an optional field. Returns the row and the day summary "
                       "for the old and new date.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}, **_ENTRY_SCHEMA["properties"]},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "delete_entry",
        "description": "Delete one entry by id. Returns the deleted row and the day summary.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
    {
        "name": "start_fast",
        "description": "Start a fast. Fails if one is already running.",
        "inputSchema": {"type": "object", "properties": _MOMENT_PROPS, "additionalProperties": False},
    },
    {
        "name": "stop_fast",
        "description": "Stop the running fast. Returns it with its length in hours.",
        "inputSchema": {"type": "object", "properties": _MOMENT_PROPS, "additionalProperties": False},
    },
    {
        "name": "update_fast",
        "description": "Change a fast's start, end or notes by id. Clearing both end fields "
                       "reopens it.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "id": {"type": "integer"},
                "start_date": {"type": "string", "description": "DD/MM/YYYY"},
                "start_time": {"type": "string", "description": "HH:MM"},
                "end_date": {"type": ["string", "null"], "description": "DD/MM/YYYY"},
                "end_time": {"type": ["string", "null"], "description": "HH:MM"},
                "notes": {"type": ["string", "null"]},
            },
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "set_goal",
        "description": "Set the net-carb goal for one day (default 20 g). Later days that "
                       "have no entries yet carry it over; days already started keep theirs. "
                       "null resets the day to the goal carried over from before.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "DD/MM/YYYY. Default: today."},
                "net_carbs_goal": {"type": ["number", "null"], "exclusiveMinimum": 0},
            },
            "required": ["net_carbs_goal"],
            "additionalProperties": False,
        },
    },
    {
        "name": "log_body",
        "description": "Water for one day: water_ml sets the total, add_water_ml adds to it. "
                       "weight_kg, ketones_mmol, glucose_mmol (mmol/L) are saved as a new "
                       "measurement (prefer add_measurement). Returns the day's body summary.",
        "inputSchema": {
            "type": "object",
            "properties": {
                "date": {"type": "string", "description": "DD/MM/YYYY. Default: today."},
                "weight_kg": {"type": "number"},
                "ketones_mmol": {"type": "number"},
                "glucose_mmol": {"type": "number"},
                "water_ml": {"type": ["number", "null"]},
                "add_water_ml": {"type": "number"},
            },
            "additionalProperties": False,
        },
    },
    {
        "name": "add_measurement",
        "description": "Log a body measurement at a date and time: any of weight_kg, "
                       "ketones_mmol and glucose_mmol (blood, mmol/L), blood pressure bp_sys/bp_dia "
                       "(mmHg, both together), pulse (bpm), notes. At least one value. "
                       "Returns the measurement and the day's body summary (latest values, GKI).",
        "inputSchema": {
            "type": "object",
            "properties": MEASURE_PROPS,
            "additionalProperties": False,
        },
    },
    {
        "name": "update_measurement",
        "description": "Change fields of one measurement by id; null clears a value.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}, **MEASURE_PROPS},
            "required": ["id"],
            "additionalProperties": False,
        },
    },
    {
        "name": "delete_measurement",
        "description": "Delete one measurement by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
    {
        "name": "delete_fast",
        "description": "Delete one fast by id.",
        "inputSchema": {
            "type": "object",
            "properties": {"id": {"type": "integer"}},
            "required": ["id"],
        },
    },
]


def log(msg):
    sys.stderr.write(f"keto-mcp: {msg}\n")
    sys.stderr.flush()


# ---- transport -----------------------------------------------------------

class Transport:
    def __init__(self, inp, out):
        self.inp = inp
        self.out = out
        self.framed = True

    def read(self):
        """Return one message body (bytes), or None at EOF."""
        while True:
            line = self.inp.readline()
            if not line:
                return None
            stripped = line.strip()
            if not stripped:
                continue
            if stripped.startswith(b"{") or stripped.startswith(b"["):
                self.framed = False
                return stripped
            headers = {}
            while stripped:
                name, _, value = stripped.decode("ascii", "replace").partition(":")
                headers[name.strip().lower()] = value.strip()
                line = self.inp.readline()
                if not line:
                    return None
                stripped = line.strip()
            try:
                length = int(headers["content-length"])
            except (KeyError, ValueError):
                log(f"bad header block: {headers!r}")
                continue
            self.framed = True
            return self.inp.read(length)

    def write(self, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        if self.framed:
            self.out.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
        else:
            self.out.write(body + b"\n")
        self.out.flush()


# ---- handlers ------------------------------------------------------------

class RPCError(Exception):
    def __init__(self, code, message):
        super().__init__(message)
        self.code = code
        self.message = message


def _tool_result(obj, is_error=False):
    text = obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)
    return {"content": [{"type": "text", "text": text}], "isError": is_error}


def call_tool(name, args):
    if not isinstance(args, dict):
        raise db.ValidationError("arguments must be an object")
    if name == "add_entries":
        entries = args.get("entries")
        if not isinstance(entries, list) or not entries:
            raise db.ValidationError("entries must be a non-empty array")
        created, days = db.add_entries(entries, source="mcp")
        return {"created": created, "days": days}
    if name == "get_day":
        return db.get_day(args.get("date"))
    if name == "recent_days":
        return db.recent_days(args.get("n"))
    if name == "update_entry":
        changes = {k: v for k, v in args.items() if k != "id"}
        row, days = db.update_entry(args.get("id"), changes)
        return {"entry": row, "days": days}
    if name == "delete_entry":
        row, day = db.delete_entry(args.get("id"))
        return {"deleted": row, "day": day}
    if name == "start_fast":
        return {"fast": db.start_fast(args, source="mcp")}
    if name == "stop_fast":
        return {"fast": db.stop_fast(args)}
    if name == "update_fast":
        changes = {k: v for k, v in args.items() if k != "id"}
        return {"fast": db.update_fast(args.get("id"), changes)}
    if name == "log_body":
        return db.log_body(args, source="mcp")
    if name == "add_measurement":
        row, body = db.add_measurement(args, source="mcp")
        return {"measurement": row, "body": body}
    if name == "update_measurement":
        changes = {k: v for k, v in args.items() if k != "id"}
        row, body = db.update_measurement(args.get("id"), changes)
        return {"measurement": row, "body": body}
    if name == "delete_measurement":
        row, body = db.delete_measurement(args.get("id"))
        return {"deleted": row, "body": body}
    if name == "set_goal":
        return db.set_goal(args)
    if name == "delete_fast":
        return {"deleted": db.delete_fast(args.get("id"))}
    raise RPCError(-32602, f"unknown tool: {name}")


def handle(method, params):
    if method == "initialize":
        requested = params.get("protocolVersion")
        version = requested if requested in PROTOCOL_VERSIONS else PROTOCOL_VERSIONS[0]
        return {
            "protocolVersion": version,
            "capabilities": {"tools": {"listChanged": False}},
            "serverInfo": SERVER_INFO,
        }
    if method == "ping":
        return {}
    if method == "tools/list":
        return {"tools": TOOLS}
    if method == "tools/call":
        name = params.get("name")
        try:
            return _tool_result(call_tool(name, params.get("arguments") or {}))
        except db.ValidationError as e:
            return _tool_result(f"error: {e}", is_error=True)
    raise RPCError(-32601, f"method not found: {method}")


def process(msg):
    """Handle one decoded message. Returns a response dict or None."""
    if not isinstance(msg, dict) or msg.get("jsonrpc") != "2.0" or "method" not in msg:
        return {"jsonrpc": "2.0", "id": msg.get("id") if isinstance(msg, dict) else None,
                "error": {"code": -32600, "message": "invalid request"}}
    is_request = "id" in msg
    method = msg["method"]
    params = msg.get("params") or {}
    if not is_request:
        return None  # notifications: initialized, cancelled, ...
    try:
        if not isinstance(params, dict):
            raise RPCError(-32602, "params must be an object")
        return {"jsonrpc": "2.0", "id": msg["id"], "result": handle(method, params)}
    except RPCError as e:
        return {"jsonrpc": "2.0", "id": msg["id"],
                "error": {"code": e.code, "message": e.message}}
    except Exception as e:
        log(f"internal error in {method}: {e!r}")
        return {"jsonrpc": "2.0", "id": msg["id"],
                "error": {"code": -32603, "message": "internal error"}}


def main():
    t = Transport(sys.stdin.buffer, sys.stdout.buffer)
    log(f"started, db={db.db_path()}")
    while True:
        body = t.read()
        if body is None:
            break
        try:
            msg = json.loads(body.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            t.write({"jsonrpc": "2.0", "id": None,
                     "error": {"code": -32700, "message": "parse error"}})
            continue
        if isinstance(msg, list):
            replies = [r for r in (process(m) for m in msg) if r is not None]
            if replies:
                t.write(replies)
        else:
            reply = process(msg)
            if reply is not None:
                t.write(reply)
    log("stdin closed, exiting")


if __name__ == "__main__":
    main()
