"""Shared SQLite access and validation for the keto log.

Used by both server.py (web) and mcp_server.py (stdio MCP). Both processes
may write at the same time, so every connection uses WAL and a busy timeout.
"""

import math
import os
import re
import sqlite3
from datetime import date, datetime
from zoneinfo import ZoneInfo

DEFAULT_DB = "/home/kfir/dev/keto/data/keto.sqlite"
TZ = ZoneInfo("Europe/Copenhagen")
GOAL_NET_CARBS = 20
RECENT_DEFAULT = 14
RECENT_MAX = 60

NUMERIC_FIELDS = ("fasting_hours", "calories", "fat_g", "protein_g")
TEXT_FIELDS = ("quantity", "notes", "meal")
ENTRY_FIELDS = (
    "date", "time", "fasting_hours", "item", "quantity", "calories",
    "fat_g", "protein_g", "net_carbs_g", "notes", "meal",
)
TOTAL_FIELDS = ("net_carbs_g", "calories", "fat_g", "protein_g", "fasting_hours")

SCHEMA = """
CREATE TABLE IF NOT EXISTS entries (
    id            INTEGER PRIMARY KEY,
    entry_date    TEXT NOT NULL,
    entry_time    TEXT,
    fasting_hours REAL,
    item          TEXT NOT NULL,
    quantity      TEXT,
    calories      REAL,
    fat_g         REAL,
    protein_g     REAL,
    net_carbs_g   REAL NOT NULL,
    notes         TEXT,
    meal          TEXT,
    source        TEXT NOT NULL CHECK (source IN ('ui', 'mcp')),
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_date_idx ON entries (entry_date);
"""

_DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class ValidationError(ValueError):
    """Bad client input. The message is safe to show to the client."""


def db_path():
    return os.environ.get("KETO_DB") or DEFAULT_DB


def connect():
    path = db_path()
    parent = os.path.dirname(os.path.abspath(path))
    os.makedirs(parent, exist_ok=True)
    conn = sqlite3.connect(path, timeout=10)
    conn.row_factory = sqlite3.Row
    conn.execute("PRAGMA busy_timeout = 10000")
    conn.execute("PRAGMA journal_mode = WAL")
    conn.executescript(SCHEMA)
    return conn


# ---- dates ---------------------------------------------------------------

def today_iso():
    return datetime.now(TZ).date().isoformat()


def parse_date(value):
    """DD/MM/YYYY -> YYYY-MM-DD. None or empty means today (Copenhagen)."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return today_iso()
    if not isinstance(value, str):
        raise ValidationError("date must be a string in DD/MM/YYYY format")
    m = _DATE_RE.match(value.strip())
    if not m:
        raise ValidationError(f"date must be DD/MM/YYYY, got {value!r}")
    dd, mm, yyyy = (int(g) for g in m.groups())
    try:
        return date(yyyy, mm, dd).isoformat()
    except ValueError:
        raise ValidationError(f"date is not a real calendar date: {value!r}")


def format_date(iso):
    y, m, d = iso.split("-")
    return f"{d}/{m}/{y}"


# ---- validation ----------------------------------------------------------

def _number(value, field, required=False):
    if value is None or (isinstance(value, str) and value.strip() == ""):
        if required:
            raise ValidationError(f"{field} is required and must be a number")
        return None
    if isinstance(value, bool):
        raise ValidationError(f"{field} must be a number")
    if isinstance(value, (int, float)):
        num = float(value)
    elif isinstance(value, str):
        try:
            num = float(value.strip().replace(",", "."))
        except ValueError:
            raise ValidationError(f"{field} must be a number, got {value!r}")
    else:
        raise ValidationError(f"{field} must be a number")
    if not math.isfinite(num):
        raise ValidationError(f"{field} must be a finite number")
    return num


def _text(value, field):
    if value is None:
        return None
    if isinstance(value, bool):
        raise ValidationError(f"{field} must be a string")
    if isinstance(value, (int, float)):
        value = str(value)
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a string")
    if value.strip() == "":
        return None
    return value


def validate_entry(obj):
    """Validate one incoming entry. Returns a dict of DB column values."""
    if not isinstance(obj, dict):
        raise ValidationError("each entry must be a JSON object")
    unknown = sorted(set(obj) - set(ENTRY_FIELDS) - {"source"})
    if unknown:
        raise ValidationError(f"unknown field(s): {', '.join(unknown)}")

    item = obj.get("item")
    if not isinstance(item, str) or item.strip() == "":
        raise ValidationError("item is required and must not be empty")

    time_val = obj.get("time")
    if time_val is None or (isinstance(time_val, str) and time_val.strip() == ""):
        time_val = None
    elif not isinstance(time_val, str) or not _TIME_RE.match(time_val.strip()):
        raise ValidationError(f"time must be HH:MM (24h), got {time_val!r}")
    else:
        time_val = time_val.strip()

    row = {
        "entry_date": parse_date(obj.get("date")),
        "entry_time": time_val,
        "item": item,
        "net_carbs_g": _number(obj.get("net_carbs_g"), "net_carbs_g", required=True),
    }
    for f in NUMERIC_FIELDS:
        row[f] = _number(obj.get(f), f)
    for f in TEXT_FIELDS:
        row[f] = _text(obj.get(f), f)
    return row


def validate_entries(payload):
    """Accept one object or a list of objects. Validates all before any write."""
    items = payload if isinstance(payload, list) else [payload]
    if not items:
        raise ValidationError("no entries given")
    rows = []
    for i, obj in enumerate(items):
        try:
            rows.append(validate_entry(obj))
        except ValidationError as e:
            if len(items) > 1:
                raise ValidationError(f"entry {i}: {e}")
            raise
    return rows


# ---- reads and writes ----------------------------------------------------

def _row_out(r):
    return {
        "id": r["id"],
        "date": format_date(r["entry_date"]),
        "time": r["entry_time"],
        "fasting_hours": r["fasting_hours"],
        "item": r["item"],
        "quantity": r["quantity"],
        "calories": r["calories"],
        "fat_g": r["fat_g"],
        "protein_g": r["protein_g"],
        "net_carbs_g": r["net_carbs_g"],
        "notes": r["notes"],
        "meal": r["meal"],
        "source": r["source"],
        "created_at": r["created_at"],
    }


def _round(x):
    return None if x is None else round(x, 2)


def _summary(iso, rows, include_entries=True):
    totals = {}
    for f in TOTAL_FIELDS:
        vals = [r[f] for r in rows if r[f] is not None]
        totals[f] = _round(sum(vals)) if vals else None
    net = totals["net_carbs_g"] or 0.0
    totals["net_carbs_g"] = _round(net)
    out = {
        "date": format_date(iso),
        "count": len(rows),
        "totals": totals,
        "goal": GOAL_NET_CARBS,
        "remaining": _round(GOAL_NET_CARBS - net),
        "over_goal": net > GOAL_NET_CARBS,
    }
    if include_entries:
        out["entries"] = [_row_out(r) for r in rows]
    return out


def _day_rows(conn, iso):
    return conn.execute(
        "SELECT * FROM entries WHERE entry_date = ? "
        "ORDER BY entry_time IS NULL, entry_time, id",
        (iso,),
    ).fetchall()


def get_day(date_str=None):
    iso = parse_date(date_str)
    conn = connect()
    try:
        return _summary(iso, _day_rows(conn, iso))
    finally:
        conn.close()


def parse_recent_n(value):
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return RECENT_DEFAULT
    if isinstance(value, bool):
        raise ValidationError("n must be a positive integer")
    try:
        n = int(value)
    except (TypeError, ValueError):
        raise ValidationError(f"n must be a positive integer, got {value!r}")
    if isinstance(value, float) and value != n:
        raise ValidationError("n must be a positive integer")
    if n < 1:
        raise ValidationError("n must be a positive integer")
    return min(n, RECENT_MAX)


def recent_days(n=None):
    """One summary per logged day, newest first."""
    n = parse_recent_n(n)
    conn = connect()
    try:
        dates = [r[0] for r in conn.execute(
            "SELECT DISTINCT entry_date FROM entries ORDER BY entry_date DESC LIMIT ?",
            (n,),
        )]
        return [_summary(d, _day_rows(conn, d), include_entries=False) for d in dates]
    finally:
        conn.close()


def add_entries(payload, source):
    """Validate and insert atomically. Returns (created rows, {date: summary})."""
    if source not in ("ui", "mcp"):
        raise ValueError("bad source")
    rows = validate_entries(payload)
    created_at = datetime.now(TZ).isoformat(timespec="seconds")
    conn = connect()
    try:
        ids = []
        with conn:
            for r in rows:
                cur = conn.execute(
                    "INSERT INTO entries (entry_date, entry_time, fasting_hours, item,"
                    " quantity, calories, fat_g, protein_g, net_carbs_g, notes, meal,"
                    " source, created_at) VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?)",
                    (r["entry_date"], r["entry_time"], r["fasting_hours"], r["item"],
                     r["quantity"], r["calories"], r["fat_g"], r["protein_g"],
                     r["net_carbs_g"], r["notes"], r["meal"], source, created_at),
                )
                ids.append(cur.lastrowid)
        marks = ",".join("?" * len(ids))
        created = [_row_out(r) for r in conn.execute(
            f"SELECT * FROM entries WHERE id IN ({marks}) ORDER BY id", ids)]
        touched = sorted({r["entry_date"] for r in rows})
        days = {format_date(d): _summary(d, _day_rows(conn, d)) for d in touched}
        return created, days
    finally:
        conn.close()
