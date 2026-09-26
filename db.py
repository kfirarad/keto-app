"""Shared SQLite access and validation for the keto log.

Used by both server.py (web) and mcp_server.py (stdio MCP). Both processes
may write at the same time, so every connection uses WAL and a busy timeout.
"""

import math
import os
import re
import sqlite3
from datetime import date, datetime, timedelta, timezone
from zoneinfo import ZoneInfo

DEFAULT_DB = "/home/kfir/dev/keto/data/keto.sqlite"
TZ = ZoneInfo("Europe/Copenhagen")
GOAL_NET_CARBS = 20
RECENT_DEFAULT = 14
RECENT_MAX = 60
OVERVIEW_DEFAULT = 7
FOODS_MAX = 500
FREQUENT_DEFAULT = 8
FREQUENT_DAYS = 30
GOAL_MAX = 1000
CLOCK_SLACK = timedelta(minutes=2)

NUMERIC_FIELDS = ("fasting_hours", "calories", "fat_g", "protein_g")
TEXT_FIELDS = ("quantity", "notes", "meal")
ENTRY_FIELDS = (
    "date", "time", "fasting_hours", "item", "quantity", "calories",
    "fat_g", "protein_g", "net_carbs_g", "notes", "meal",
)
TOTAL_FIELDS = ("net_carbs_g", "calories", "fat_g", "protein_g", "fasting_hours")
FAST_FIELDS = ("start_date", "start_time", "end_date", "end_time", "notes")

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
    source        TEXT NOT NULL CHECK (source IN ('ui', 'mcp', 'sheet')),
    created_at    TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS entries_date_idx ON entries (entry_date);

CREATE TABLE IF NOT EXISTS fasts (
    id          INTEGER PRIMARY KEY,
    start_date  TEXT NOT NULL,
    start_time  TEXT NOT NULL,
    end_date    TEXT,
    end_time    TEXT,
    notes       TEXT,
    source      TEXT NOT NULL CHECK (source IN ('ui', 'mcp')),
    created_at  TEXT NOT NULL,
    CHECK ((end_date IS NULL) = (end_time IS NULL))
);
CREATE INDEX IF NOT EXISTS fasts_end_idx ON fasts (end_date);

-- Daily body readings: one row per day, any column may be empty.
CREATE TABLE IF NOT EXISTS body_log (
    log_date     TEXT PRIMARY KEY,
    weight_kg    REAL,
    ketones_mmol REAL,
    glucose_mmol REAL,
    water_ml     REAL,
    updated_at   TEXT NOT NULL
);

-- A day's net-carb goal is the latest row on or before that day, else GOAL_NET_CARBS.
CREATE TABLE IF NOT EXISTS day_goals (
    goal_date      TEXT PRIMARY KEY,
    net_carbs_goal REAL NOT NULL CHECK (net_carbs_goal > 0),
    updated_at     TEXT NOT NULL
);
-- At most one running fast.
CREATE UNIQUE INDEX IF NOT EXISTS fasts_one_open ON fasts (ifnull(end_date, ''))
    WHERE end_date IS NULL;
"""

_DATE_RE = re.compile(r"^(\d{2})/(\d{2})/(\d{4})$")
_TIME_RE = re.compile(r"^([01]\d|2[0-3]):([0-5]\d)$")


class ValidationError(ValueError):
    """Bad client input. The message is safe to show to the client."""


class NotFoundError(ValidationError):
    """Unknown entry or fast id."""


class ConflictError(ValidationError):
    """Request clashes with current state, e.g. a fast is already running."""


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


def now_hhmm():
    return datetime.now(TZ).strftime("%H:%M")


def parse_date(value, field="date", default_today=True):
    """DD/MM/YYYY -> YYYY-MM-DD. None or empty means today (Copenhagen)."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        if default_today:
            return today_iso()
        raise ValidationError(f"{field} is required (DD/MM/YYYY)")
    if not isinstance(value, str):
        raise ValidationError(f"{field} must be a string in DD/MM/YYYY format")
    m = _DATE_RE.match(value.strip())
    if not m:
        raise ValidationError(f"{field} must be DD/MM/YYYY, got {value!r}")
    dd, mm, yyyy = (int(g) for g in m.groups())
    try:
        return date(yyyy, mm, dd).isoformat()
    except ValueError:
        raise ValidationError(f"{field} is not a real calendar date: {value!r}")


def parse_time(value, field="time", default_now=False):
    """HH:MM (24h). None or empty means None, or the current time if default_now."""
    if value is None or (isinstance(value, str) and value.strip() == ""):
        return now_hhmm() if default_now else None
    if not isinstance(value, str) or not _TIME_RE.match(value.strip()):
        raise ValidationError(f"{field} must be HH:MM (24h), got {value!r}")
    return value.strip()


def format_date(iso):
    y, m, d = iso.split("-")
    return f"{d}/{m}/{y}"


def _moment(iso, hhmm):
    """Local Copenhagen wall time -> aware UTC datetime (DST-correct)."""
    local = datetime.fromisoformat(f"{iso}T{hhmm}").replace(tzinfo=TZ)
    return local.astimezone(timezone.utc)


def _hours_between(a, b):
    return (b - a).total_seconds() / 3600


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


def _id(value, what):
    if isinstance(value, bool):
        raise ValidationError(f"{what} id must be a positive integer")
    if isinstance(value, str) and value.strip().isdigit():
        value = int(value.strip())
    if not isinstance(value, int) or value < 1:
        raise ValidationError(f"{what} id must be a positive integer")
    return value


def _check_fields(obj, allowed, what):
    if not isinstance(obj, dict):
        raise ValidationError(f"{what} must be a JSON object")
    unknown = sorted(set(obj) - set(allowed))
    if unknown:
        raise ValidationError(f"unknown field(s): {', '.join(unknown)}")


def validate_entry(obj):
    """Validate one incoming entry. Returns a dict of DB column values."""
    if not isinstance(obj, dict):
        raise ValidationError("each entry must be a JSON object")
    _check_fields(obj, ENTRY_FIELDS + ("source",), "entry")

    item = obj.get("item")
    if not isinstance(item, str) or item.strip() == "":
        raise ValidationError("item is required and must not be empty")

    row = {
        "entry_date": parse_date(obj.get("date")),
        "entry_time": parse_time(obj.get("time")),
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


# ---- output shapes -------------------------------------------------------

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


def _fast_out(r):
    start = _moment(r["start_date"], r["start_time"])
    out = {
        "id": r["id"],
        "start_date": format_date(r["start_date"]),
        "start_time": r["start_time"],
        "end_date": None,
        "end_time": None,
        "start_at": start.astimezone(TZ).isoformat(),
        "end_at": None,
        "active": r["end_date"] is None,
        "hours": None,
        "notes": r["notes"],
        "source": r["source"],
    }
    if r["end_date"] is None:
        out["hours_so_far"] = _round(max(0.0, _hours_between(start, datetime.now(timezone.utc))))
    else:
        end = _moment(r["end_date"], r["end_time"])
        out["end_date"] = format_date(r["end_date"])
        out["end_time"] = r["end_time"]
        out["end_at"] = end.astimezone(TZ).isoformat()
        out["hours"] = _round(_hours_between(start, end))
    return out


def _clean_num(x):
    return int(x) if float(x).is_integer() else x


def _goal_for(conn, iso):
    """(goal, source) for a day. source: "set" on this day, "inherited" from an
    earlier day, or "default"."""
    r = conn.execute(
        "SELECT goal_date, net_carbs_goal FROM day_goals WHERE goal_date <= ?"
        " ORDER BY goal_date DESC LIMIT 1", (iso,)).fetchone()
    if r is None:
        return GOAL_NET_CARBS, "default"
    return _clean_num(r["net_carbs_goal"]), ("set" if r["goal_date"] == iso else "inherited")


def _summary(conn, iso, rows, include_entries=True):
    goal, goal_source = _goal_for(conn, iso)
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
        "goal": goal,
        "goal_source": goal_source,
        "remaining": _round(goal - net),
        "over_goal": net > goal,
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


def _active_fast_row(conn):
    return conn.execute("SELECT * FROM fasts WHERE end_date IS NULL").fetchone()


def _day(conn, iso):
    """Full day payload: entries, totals, goal, fasts that ended this day, running fast."""
    out = _summary(conn, iso, _day_rows(conn, iso))
    fasts = [_fast_out(r) for r in conn.execute(
        "SELECT * FROM fasts WHERE end_date = ? ORDER BY end_time, id", (iso,))]
    out["fasts"] = fasts
    out["fast_hours"] = _round(sum(f["hours"] for f in fasts)) if fasts else None
    active = _active_fast_row(conn)
    out["active_fast"] = _fast_out(active) if active else None
    out["body"] = _body(conn, iso)
    return out


# ---- entries -------------------------------------------------------------

def get_day(date_str=None):
    iso = parse_date(date_str)
    conn = connect()
    try:
        return _day(conn, iso)
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


def days_overview(end=None, n=None):
    """Calendar days ending at `end` (default today), oldest first, including
    days with no entries, plus average, days within goal, and streaks.

    A streak counts consecutive logged days that stayed within their goal. The
    current streak ends at `end`, or the day before if `end` has no entries yet.
    """
    end_iso = parse_date(end)
    n = OVERVIEW_DEFAULT if n is None or (isinstance(n, str) and not n.strip()) else parse_recent_n(n)
    end_day = date.fromisoformat(end_iso)
    isos = [(end_day - timedelta(days=i)).isoformat() for i in range(n - 1, -1, -1)]
    conn = connect()
    try:
        days = [_summary(conn, d, _day_rows(conn, d), include_entries=False) for d in isos]
        logged = [d for d in days if d["count"]]
        good = set()
        for d in [r[0] for r in conn.execute(
                "SELECT DISTINCT entry_date FROM entries WHERE entry_date <= ? ORDER BY entry_date",
                (end_iso,))]:
            if not _summary(conn, d, _day_rows(conn, d), include_entries=False)["over_goal"]:
                good.add(d)
    finally:
        conn.close()

    cur_day = end_day if days[-1]["count"] else end_day - timedelta(days=1)
    current = 0
    while cur_day.isoformat() in good:
        current += 1
        cur_day -= timedelta(days=1)
    best = run = 0
    prev = None
    for d in sorted(good):
        day = date.fromisoformat(d)
        run = run + 1 if prev is not None and day - prev == timedelta(days=1) else 1
        best = max(best, run)
        prev = day

    return {
        "days": days,
        "average_net_carbs_g": _round(sum(d["totals"]["net_carbs_g"] for d in logged) / len(logged))
        if logged else None,
        "logged_days": len(logged),
        "within_goal_days": sum(1 for d in logged if not d["over_goal"]),
        "streak": {"current": current, "best": best},
    }


def recent_days(n=None):
    """One summary per logged day, newest first."""
    n = parse_recent_n(n)
    conn = connect()
    try:
        dates = [r[0] for r in conn.execute(
            "SELECT DISTINCT entry_date FROM entries ORDER BY entry_date DESC LIMIT ?",
            (n,),
        )]
        return [_summary(conn, d, _day_rows(conn, d), include_entries=False) for d in dates]
    finally:
        conn.close()


def _food_out(r):
    return {
        "item": r["item"],
        "quantity": r["quantity"],
        "calories": r["calories"],
        "fat_g": r["fat_g"],
        "protein_g": r["protein_g"],
        "net_carbs_g": r["net_carbs_g"],
        "meal": r["meal"],
        "last_date": format_date(r["entry_date"]),
        "uses": r["uses"],
    }


_LATEST_PER_ITEM = (
    "SELECT * FROM ("
    "  SELECT e.*, ROW_NUMBER() OVER (PARTITION BY item"
    "           ORDER BY entry_date DESC, entry_time DESC, id DESC) AS rn,"
    "         COUNT(*) OVER (PARTITION BY item) AS uses"
    "  FROM entries e WHERE entry_date >= ?)"
    " WHERE rn = 1"
)


def recent_foods():
    """Latest logged row for each distinct item, most recently eaten first.

    The UI uses these as templates when adding an entry.
    """
    conn = connect()
    try:
        rows = conn.execute(
            _LATEST_PER_ITEM + " ORDER BY entry_date DESC, entry_time DESC, id DESC LIMIT ?",
            ("0000-00-00", FOODS_MAX)).fetchall()
        return [_food_out(r) for r in rows]
    finally:
        conn.close()


def frequent_foods(top=FREQUENT_DEFAULT, days=FREQUENT_DAYS):
    """The items logged most often in the last `days` days, latest values each.
    Used for the one-tap "log again" row."""
    top = parse_recent_n(top) if top is not None else FREQUENT_DEFAULT
    since = (datetime.now(TZ).date() - timedelta(days=days)).isoformat()
    conn = connect()
    try:
        rows = conn.execute(
            _LATEST_PER_ITEM + " ORDER BY uses DESC, entry_date DESC, entry_time DESC, id DESC"
            " LIMIT ?", (since, top)).fetchall()
        return [_food_out(r) for r in rows]
    finally:
        conn.close()


def meal_names():
    """Distinct meal names, most used first."""
    conn = connect()
    try:
        return [r[0] for r in conn.execute(
            "SELECT meal FROM entries WHERE meal IS NOT NULL"
            " GROUP BY meal ORDER BY COUNT(*) DESC, MAX(entry_date) DESC")]
    finally:
        conn.close()


def add_entries(payload, source):
    """Validate and insert atomically. Returns (created rows, {date: summary})."""
    if source not in ("ui", "mcp", "sheet"):
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
        days = {format_date(d): _day(conn, d) for d in touched}
        return created, days
    finally:
        conn.close()


def _get_entry(conn, eid):
    r = conn.execute("SELECT * FROM entries WHERE id = ?", (eid,)).fetchone()
    if r is None:
        raise NotFoundError(f"entry {eid} not found")
    return r


def update_entry(entry_id, changes):
    """Change some fields of one entry. Omitted fields keep their value; null or
    "" clears an optional field. Returns (row, {date: summary}) for the old and
    new date."""
    eid = _id(entry_id, "entry")
    if not isinstance(changes, dict):
        raise ValidationError("changes must be a JSON object")
    changes = {k: v for k, v in changes.items() if k not in ("id", "source", "created_at")}
    _check_fields(changes, ENTRY_FIELDS, "changes")
    if not changes:
        raise ValidationError("no fields to change")
    if "date" in changes and (changes["date"] is None or str(changes["date"]).strip() == ""):
        del changes["date"]  # a blank date keeps the entry where it is
    conn = connect()
    try:
        with conn:
            old = _get_entry(conn, eid)
            merged = {k: v for k, v in _row_out(old).items() if k in ENTRY_FIELDS}
            merged.update(changes)
            r = validate_entry(merged)
            conn.execute(
                "UPDATE entries SET entry_date=?, entry_time=?, fasting_hours=?, item=?,"
                " quantity=?, calories=?, fat_g=?, protein_g=?, net_carbs_g=?, notes=?,"
                " meal=? WHERE id=?",
                (r["entry_date"], r["entry_time"], r["fasting_hours"], r["item"],
                 r["quantity"], r["calories"], r["fat_g"], r["protein_g"],
                 r["net_carbs_g"], r["notes"], r["meal"], eid),
            )
        row = _row_out(_get_entry(conn, eid))
        touched = sorted({old["entry_date"], r["entry_date"]})
        return row, {format_date(d): _day(conn, d) for d in touched}
    finally:
        conn.close()


def delete_entry(entry_id):
    """Delete one entry. Returns (deleted row, day summary)."""
    eid = _id(entry_id, "entry")
    conn = connect()
    try:
        with conn:
            old = _get_entry(conn, eid)
            conn.execute("DELETE FROM entries WHERE id = ?", (eid,))
        return _row_out(old), _day(conn, old["entry_date"])
    finally:
        conn.close()


# ---- fasts ---------------------------------------------------------------

def _check_fast_times(start_iso, start_time, end_iso, end_time):
    now = datetime.now(timezone.utc)
    start = _moment(start_iso, start_time)
    if start > now + CLOCK_SLACK:
        raise ValidationError("fast start is in the future")
    if end_iso is not None:
        end = _moment(end_iso, end_time)
        if end > now + CLOCK_SLACK:
            raise ValidationError("fast end is in the future")
        if end <= start:
            raise ValidationError("fast end must be after its start")


def _get_fast(conn, fid):
    r = conn.execute("SELECT * FROM fasts WHERE id = ?", (fid,)).fetchone()
    if r is None:
        raise NotFoundError(f"fast {fid} not found")
    return r


def start_fast(payload, source):
    """Start a fast. payload: date (DD/MM/YYYY), time (HH:MM), notes; date and
    time default to now."""
    if source not in ("ui", "mcp"):
        raise ValueError("bad source")
    payload = payload or {}
    _check_fields(payload, ("date", "time", "notes"), "body")
    iso = parse_date(payload.get("date"))
    hhmm = parse_time(payload.get("time"), default_now=True)
    notes = _text(payload.get("notes"), "notes")
    _check_fast_times(iso, hhmm, None, None)
    created_at = datetime.now(TZ).isoformat(timespec="seconds")
    conn = connect()
    try:
        try:
            with conn:
                if _active_fast_row(conn) is not None:
                    raise ConflictError("a fast is already running; stop it first")
                cur = conn.execute(
                    "INSERT INTO fasts (start_date, start_time, notes, source, created_at)"
                    " VALUES (?,?,?,?,?)", (iso, hhmm, notes, source, created_at))
        except sqlite3.IntegrityError:
            raise ConflictError("a fast is already running; stop it first")
        return _fast_out(_get_fast(conn, cur.lastrowid))
    finally:
        conn.close()


def stop_fast(payload):
    """Stop the running fast. payload: date, time (default now), notes (optional,
    replaces the fast's notes when given)."""
    payload = payload or {}
    _check_fields(payload, ("date", "time", "notes"), "body")
    iso = parse_date(payload.get("date"))
    hhmm = parse_time(payload.get("time"), default_now=True)
    conn = connect()
    try:
        with conn:
            r = _active_fast_row(conn)
            if r is None:
                raise ConflictError("no fast is running")
            _check_fast_times(r["start_date"], r["start_time"], iso, hhmm)
            notes = _text(payload["notes"], "notes") if "notes" in payload else r["notes"]
            conn.execute("UPDATE fasts SET end_date=?, end_time=?, notes=? WHERE id=?",
                         (iso, hhmm, notes, r["id"]))
        return _fast_out(_get_fast(conn, r["id"]))
    finally:
        conn.close()


def update_fast(fast_id, changes):
    """Change start/end/notes of a fast. Clearing both end fields reopens it."""
    fid = _id(fast_id, "fast")
    _check_fields(changes, FAST_FIELDS + ("id",), "changes")
    changes = {k: v for k, v in changes.items() if k != "id"}
    if not changes:
        raise ValidationError("no fields to change")
    conn = connect()
    try:
        try:
            with conn:
                old = _fast_out(_get_fast(conn, fid))
                cur = {k: old[k] for k in FAST_FIELDS}
                cur.update(changes)
                sd = parse_date(cur["start_date"], "start_date", default_today=False)
                st = parse_time(cur["start_time"], "start_time")
                if st is None:
                    raise ValidationError("start_time is required (HH:MM)")
                end_blank = [cur[k] is None or str(cur[k]).strip() == ""
                             for k in ("end_date", "end_time")]
                if all(end_blank):
                    ed = et = None
                    other = _active_fast_row(conn)
                    if other is not None and other["id"] != fid:
                        raise ConflictError("another fast is already running")
                elif any(end_blank):
                    raise ValidationError("end_date and end_time must both be set or both be empty")
                else:
                    ed = parse_date(cur["end_date"], "end_date", default_today=False)
                    et = parse_time(cur["end_time"], "end_time")
                _check_fast_times(sd, st, ed, et)
                conn.execute(
                    "UPDATE fasts SET start_date=?, start_time=?, end_date=?, end_time=?,"
                    " notes=? WHERE id=?",
                    (sd, st, ed, et, _text(cur["notes"], "notes"), fid))
        except sqlite3.IntegrityError:
            raise ConflictError("another fast is already running")
        return _fast_out(_get_fast(conn, fid))
    finally:
        conn.close()


def delete_fast(fast_id):
    fid = _id(fast_id, "fast")
    conn = connect()
    try:
        with conn:
            old = _fast_out(_get_fast(conn, fid))
            conn.execute("DELETE FROM fasts WHERE id = ?", (fid,))
        return old
    finally:
        conn.close()


# ---- daily goal ----------------------------------------------------------

def set_goal(payload):
    """Set the net-carb goal for one day. payload: date (DD/MM/YYYY, default
    today), net_carbs_goal (number; null resets the day to the goal it would
    carry over). Later days follow unless they already have entries: those
    keep the goal they had. Returns the day summary."""
    _check_fields(payload, ("date", "net_carbs_goal"), "body")
    iso = parse_date(payload.get("date"))
    if "net_carbs_goal" not in payload:
        raise ValidationError("net_carbs_goal is required (a number, or null to reset)")
    goal = _number(payload.get("net_carbs_goal"), "net_carbs_goal")
    if goal is not None and not 0 < goal <= GOAL_MAX:
        raise ValidationError(f"net_carbs_goal must be above 0 and at most {GOAL_MAX}")
    now = datetime.now(TZ).isoformat(timespec="seconds")
    conn = connect()
    try:
        with conn:
            # Later days that have started and currently take their goal from
            # this day or earlier are pinned, so the change does not rewrite them.
            started = [r[0] for r in conn.execute(
                "SELECT DISTINCT e.entry_date FROM entries e WHERE e.entry_date > ?"
                " AND NOT EXISTS (SELECT 1 FROM day_goals g"
                "   WHERE g.goal_date > ? AND g.goal_date <= e.entry_date)",
                (iso, iso))]
            pins = [(d, _goal_for(conn, d)[0], now) for d in started]
            conn.executemany(
                "INSERT INTO day_goals (goal_date, net_carbs_goal, updated_at) VALUES (?,?,?)",
                pins)
            if goal is None:
                conn.execute("DELETE FROM day_goals WHERE goal_date = ?", (iso,))
            else:
                conn.execute(
                    "INSERT INTO day_goals (goal_date, net_carbs_goal, updated_at) VALUES (?,?,?)"
                    " ON CONFLICT (goal_date) DO UPDATE SET"
                    " net_carbs_goal = excluded.net_carbs_goal, updated_at = excluded.updated_at",
                    (iso, goal, now))
        return _day(conn, iso)
    finally:
        conn.close()


# ---- body readings -------------------------------------------------------

BODY_FIELDS = {
    # field: (min, max) accepted, inclusive
    "weight_kg": (20, 400),
    "ketones_mmol": (0, 20),
    "glucose_mmol": (0.5, 40),
    "water_ml": (0, 20000),
}
WEIGHT_HISTORY_DAYS = 30


def gki_band(gki):
    """Common glucose-ketone index bands."""
    if gki is None:
        return None
    if gki < 1:
        return "very deep ketosis"
    if gki < 3:
        return "deep ketosis"
    if gki < 6:
        return "moderate ketosis"
    if gki < 9:
        return "light ketosis"
    return "not in ketosis"


def _body(conn, iso):
    r = conn.execute("SELECT * FROM body_log WHERE log_date = ?", (iso,)).fetchone()
    vals = {f: (r[f] if r is not None else None) for f in BODY_FIELDS}
    gki = None
    if vals["ketones_mmol"] and vals["glucose_mmol"] is not None:
        gki = _round(vals["glucose_mmol"] / vals["ketones_mmol"])
    prev = conn.execute(
        "SELECT log_date, weight_kg FROM body_log WHERE log_date < ? AND weight_kg IS NOT NULL"
        " ORDER BY log_date DESC LIMIT 1", (iso,)).fetchone()
    since = (date.fromisoformat(iso) - timedelta(days=WEIGHT_HISTORY_DAYS)).isoformat()
    weights = [{"date": format_date(d), "weight_kg": w} for d, w in conn.execute(
        "SELECT log_date, weight_kg FROM body_log WHERE log_date > ? AND log_date <= ?"
        " AND weight_kg IS NOT NULL ORDER BY log_date", (since, iso))]
    return {
        **vals,
        "gki": gki,
        "gki_band": gki_band(gki),
        "previous_weight": {"date": format_date(prev[0]), "weight_kg": prev[1]} if prev else None,
        "weight_change_kg": _round(vals["weight_kg"] - prev[1])
        if prev and vals["weight_kg"] is not None else None,
        "weights": weights,
    }


def log_body(payload):
    """Set body readings for one day. payload: date (default today), any of
    weight_kg, ketones_mmol, glucose_mmol, water_ml (null clears one), and
    add_water_ml to add to the day's water. Omitted fields are unchanged.
    Returns the day's body summary."""
    _check_fields(payload, ("date", "add_water_ml") + tuple(BODY_FIELDS), "body")
    iso = parse_date(payload.get("date"))
    changes = {}
    for f, (lo, hi) in BODY_FIELDS.items():
        if f in payload:
            v = _number(payload[f], f)
            if v is not None and not lo <= v <= hi:
                raise ValidationError(f"{f} must be between {lo} and {hi}")
            changes[f] = v
    add = _number(payload.get("add_water_ml"), "add_water_ml")
    if add is not None and "water_ml" in changes:
        raise ValidationError("give water_ml or add_water_ml, not both")
    if not changes and add is None:
        raise ValidationError("no readings given")
    now = datetime.now(TZ).isoformat(timespec="seconds")
    conn = connect()
    try:
        with conn:
            conn.execute("INSERT OR IGNORE INTO body_log (log_date, updated_at) VALUES (?, ?)",
                         (iso, now))
            if add is not None:
                cur = conn.execute("SELECT water_ml FROM body_log WHERE log_date = ?",
                                   (iso,)).fetchone()[0] or 0
                changes["water_ml"] = min(max(0.0, cur + add), BODY_FIELDS["water_ml"][1])
            sets = ", ".join(f"{f} = ?" for f in changes)
            conn.execute(f"UPDATE body_log SET {sets}, updated_at = ? WHERE log_date = ?",
                         (*changes.values(), now, iso))
            conn.execute("DELETE FROM body_log WHERE log_date = ? AND weight_kg IS NULL AND"
                         " ketones_mmol IS NULL AND glucose_mmol IS NULL AND"
                         " (water_ml IS NULL OR water_ml = 0)", (iso,))
        return {"date": format_date(iso), **_body(conn, iso)}
    finally:
        conn.close()


# ---- export --------------------------------------------------------------

EXPORT_TABLES = {
    "entries": ("SELECT * FROM entries ORDER BY entry_date, entry_time IS NULL, entry_time, id",
                ("entry_date",)),
    "fasts": ("SELECT * FROM fasts ORDER BY start_date, start_time, id", ("start_date", "end_date")),
    "body": ("SELECT * FROM body_log ORDER BY log_date", ("log_date",)),
}


def export_csv(table="entries"):
    """CSV text of one table with dates as DD/MM/YYYY."""
    import csv
    import io
    if table not in EXPORT_TABLES:
        raise ValidationError(f"table must be one of: {', '.join(EXPORT_TABLES)}")
    sql, date_cols = EXPORT_TABLES[table]
    conn = connect()
    try:
        cur = conn.execute(sql)
        cols = [c[0] for c in cur.description]
        buf = io.StringIO()
        w = csv.writer(buf)
        w.writerow(cols)
        for r in cur:
            w.writerow([format_date(r[c]) if c in date_cols and r[c] else r[c] for c in cols])
        return buf.getvalue()
    finally:
        conn.close()
