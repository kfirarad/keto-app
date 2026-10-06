"""Self-check for the keto tracker.

Runs against a temporary database (KETO_DB) and an in-process HTTP server on
an ephemeral loopback port, so it works whether keto.service is running or
not and never touches data/keto.sqlite. Exit code 0 means all checks passed.
"""

from datetime import date
import json
import os
import subprocess
import sys
import tempfile
import threading
import urllib.error
import urllib.request

HERE = os.path.dirname(os.path.abspath(__file__))
REAL_DB = os.path.join(HERE, "data", "keto.sqlite")

tmpdir = tempfile.TemporaryDirectory(prefix="keto-check-")
os.environ["KETO_DB"] = os.path.join(tmpdir.name, "check.sqlite")
# The assistant must never use the real key or network here.
os.environ["KETO_LLM_CONFIG"] = os.path.join(tmpdir.name, "llm.json")
for _k in ("KETO_LLM_API_KEY", "KETO_LLM_BASE_URL", "KETO_LLM_MODEL", "KETO_LLM_VISION_MODEL"):
    os.environ.pop(_k, None)
sys.path.insert(0, HERE)

import db  # noqa: E402  (must import after KETO_DB is set)
import server  # noqa: E402

failures = []


def check(name, cond, detail=""):
    print(("ok   " if cond else "FAIL ") + name + (f"  ({detail})" if detail and not cond else ""))
    if not cond:
        failures.append(name)


def http(base, method, path, body=None):
    data = None if body is None else json.dumps(body, ensure_ascii=False).encode("utf-8")
    req = urllib.request.Request(base + path, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=10) as r:
            return r.status, r.read().decode("utf-8")
    except urllib.error.HTTPError as e:
        return e.code, e.read().decode("utf-8")


def real_db_state():
    try:
        st = os.stat(REAL_DB)
        return (st.st_size, st.st_mtime_ns)
    except FileNotFoundError:
        return None


def run_http_checks():
    server.Handler.log_message = lambda *a: None
    httpd = server.make_server("127.0.0.1", 0)
    base = f"http://127.0.0.1:{httpd.server_address[1]}"
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    try:
        status, html = http(base, "GET", "/")
        check("GET / serves HTML containing 20", status == 200 and "<html" in html and "20" in html)

        today = db.format_date(db.today_iso())
        check("first_date is today on an empty log",
              json.loads(http(base, "GET", "/api/day")[1])["first_date"] == today)
        d = "01/03/2026"
        status, body = http(base, "POST", "/api/entries", [
            {"date": d, "time": "08:00", "item": "eggs", "quantity": "3",
             "calories": 210, "fat_g": 15, "protein_g": 18, "net_carbs_g": 1.5,
             "fasting_hours": 16},
            {"date": d, "time": "13:00", "item": "salad", "net_carbs_g": 4,
             "fat_g": 20},
        ])
        res = json.loads(body)
        check("insert returns 201 with created rows", status == 201 and len(res.get("created", [])) == 2, body)
        check("created rows have source=ui", all(r["source"] == "ui" for r in res.get("created", [])))

        status, body = http(base, "GET", f"/api/day?date={d}")
        day = json.loads(body)
        t = day.get("totals", {})
        check("day totals net carbs", status == 200 and t.get("net_carbs_g") == 5.5, body)
        check("first_date is the earliest logged day", day.get("first_date") == d, body)
        check("day totals fat (sum)", t.get("fat_g") == 35)
        check("blank numbers skipped, not zero", t.get("calories") == 210 and t.get("protein_g") == 18)
        check("goal/remaining/over_goal", day.get("goal") == 20 and day.get("remaining") == 14.5
              and day.get("over_goal") is False, body)
        check("entries chronological", [e["item"] for e in day["entries"]] == ["eggs", "salad"])

        status, body = http(base, "POST", "/api/entries",
                            {"date": d, "item": "bread", "net_carbs_g": 15})
        check("over_goal flips above 20", status == 201 and json.loads(body)["day"]["over_goal"] is True, body)

        heb = "גבינה צהובה"
        note = "בלי לחם, with coffee"
        status, body = http(base, "POST", "/api/entries",
                            {"date": "02/03/2026", "item": heb, "notes": note, "net_carbs_g": 0})
        check("Hebrew insert accepted (net carbs 0 allowed)", status == 201, body)
        status, body = http(base, "GET", "/api/day?date=02/03/2026")
        e = json.loads(body)["entries"][0]
        check("Hebrew item round-trip", e["item"] == heb and e["notes"] == note, repr(e))

        status, body = http(base, "POST", "/api/entries", {"date": d, "item": "", "net_carbs_g": 1})
        check("reject empty item", status == 400 and "item" in json.loads(body).get("error", ""), body)
        status, body = http(base, "POST", "/api/entries", {"date": d, "item": "   ", "net_carbs_g": 1})
        check("reject whitespace-only item", status == 400, body)
        status, body = http(base, "POST", "/api/entries", {"date": d, "item": "nuts"})
        check("reject missing net carbs", status == 400 and "net_carbs_g" in json.loads(body).get("error", ""), body)
        status, body = http(base, "POST", "/api/entries", {"date": d, "item": "nuts", "net_carbs_g": "lots"})
        check("reject non-numeric net carbs", status == 400, body)
        status, body = http(base, "POST", "/api/entries",
                            [{"date": d, "item": "ok", "net_carbs_g": 1}, {"date": d, "item": "bad"}])
        status2, body2 = http(base, "GET", f"/api/day?date={d}")
        check("batch with one bad entry inserts nothing", status == 400 and json.loads(body2)["count"] == 3)
        status, body = http(base, "GET", "/api/day?date=2026-03-01")
        check("reject ISO date in API", status == 400 and "error" in json.loads(body))

        status, body = http(base, "GET", "/api/recent?n=14")
        rec = json.loads(body)
        check("recent newest first", status == 200 and [r["date"] for r in rec] == ["02/03/2026", "01/03/2026"], body)

        status, body = http(base, "GET", "/api/day")
        check("missing date means today", status == 200
              and json.loads(body)["date"] == db.format_date(db.today_iso()), body)

        run_edit_delete_checks(base)
        run_fast_checks(base)
        run_goal_checks(base)
        run_body_checks(base)
        run_note_checks(base)
        run_insights_checks(base)

        status, body = http(base, "GET", "/api/foods")
        foods = json.loads(body)
        check("foods: one row per item, latest first", status == 200
              and len({f["item"] for f in foods}) == len(foods)
              and any(f["item"] == heb for f in foods), body)

        status, body = http(base, "GET", "/api/foods?top=3")
        top = json.loads(body)
        check("frequent foods: top n, most used first", status == 200 and len(top) <= 3
              and all(top[i]["uses"] >= top[i + 1]["uses"] for i in range(len(top) - 1)), body)
        http(base, "POST", "/api/entries", [{"item": "tea", "net_carbs_g": 0, "meal": "breakfast"}] * 2
             + [{"item": "tea", "net_carbs_g": 0, "meal": "lunch"}])
        status, body = http(base, "GET", "/api/meals")
        check("meal names, most used first", status == 200 and json.loads(body)[:2] == ["breakfast", "lunch"], body)
        run_ai_checks(base)
        run_import_checks(base)
    finally:
        httpd.shutdown()
        httpd.server_close()


def run_edit_delete_checks(base):
    d = "10/03/2026"
    status, body = http(base, "POST", "/api/entries", [
        {"date": d, "time": "09:00", "item": "cheese", "net_carbs_g": 1, "calories": 100,
         "notes": "old note"},
        {"date": d, "time": "10:00", "item": "nuts", "net_carbs_g": 2},
    ])
    ids = [r["id"] for r in json.loads(body)["created"]]

    status, body = http(base, "PATCH", f"/api/entries/{ids[0]}",
                        {"net_carbs_g": 3, "item": "גבינה", "notes": None})
    res = json.loads(body)
    check("edit entry updates fields and totals", status == 200
          and res["entry"]["item"] == "גבינה" and res["entry"]["notes"] is None
          and res["entry"]["calories"] == 100 and res["entry"]["source"] == "ui"
          and res["day"]["totals"]["net_carbs_g"] == 5, body)
    status, body = http(base, "PATCH", f"/api/entries/{ids[0]}", {"item": ""})
    check("edit rejects empty item", status == 400, body)
    status, body = http(base, "PATCH", f"/api/entries/{ids[0]}", {"net_carbs_g": None})
    check("edit rejects clearing net carbs", status == 400, body)
    status, body = http(base, "PATCH", "/api/entries/999999", {"item": "x"})
    check("edit unknown id is 404", status == 404, body)
    status, body = http(base, "PATCH", f"/api/entries/{ids[0]}", {"date": "11/03/2026"})
    res = json.loads(body)
    check("edit can move an entry to another day", status == 200
          and res["days"]["10/03/2026"]["count"] == 1 and res["days"]["11/03/2026"]["count"] == 1, body)

    status, body = http(base, "DELETE", f"/api/entries/{ids[1]}")
    check("delete entry", status == 200 and json.loads(body)["day"]["count"] == 0, body)
    status, body = http(base, "DELETE", f"/api/entries/{ids[1]}")
    check("delete twice is 404", status == 404, body)
    deleted = {"id": ids[1], "date": d, "time": "10:00", "item": "nuts", "net_carbs_g": 2,
               "source": "mcp", "created_at": "2026-03-10T10:00:00+01:00", "quantity": None,
               "calories": None, "fat_g": None, "protein_g": None, "notes": None, "meal": None,
               "fasting_hours": None}
    status, body = http(base, "POST", "/api/entries/restore", deleted)
    res = json.loads(body)
    check("restore (undo delete) keeps id, source and created_at", status == 201
          and res["entry"]["id"] == ids[1] and res["entry"]["source"] == "mcp"
          and res["entry"]["created_at"] == deleted["created_at"] and res["day"]["count"] == 1, body)
    status, body = http(base, "DELETE", f"/api/entries/{ids[1]}")
    check("restored entry can be deleted again", status == 200, body)


def run_fast_checks(base):
    status, body = http(base, "POST", "/api/fasts/start", {"date": "01/03/2026", "time": "20:00"})
    fid = json.loads(body).get("fast", {}).get("id")
    check("start fast", status == 201 and json.loads(body)["fast"]["active"] is True, body)
    status, body = http(base, "POST", "/api/fasts/start", {"date": "01/03/2026", "time": "21:00"})
    check("second start while fasting is 409", status == 409, body)
    status, body = http(base, "GET", "/api/day?date=05/01/2026")
    check("running fast visible on any day", json.loads(body)["active_fast"]["id"] == fid, body)
    status, body = http(base, "POST", "/api/fasts/stop", {"date": "01/03/2026", "time": "19:00"})
    check("stop before start rejected", status == 400, body)
    status, body = http(base, "POST", "/api/fasts/stop", {"date": "02/03/2026", "time": "12:30"})
    check("stop fast gives hours", status == 200 and json.loads(body)["fast"]["hours"] == 16.5, body)
    status, body = http(base, "POST", "/api/fasts/stop", {})
    check("stop with no running fast is 409", status == 409, body)
    status, body = http(base, "GET", "/api/day?date=02/03/2026")
    day = json.loads(body)
    check("fast listed on the day it ended", [f["id"] for f in day["fasts"]] == [fid]
          and day["fast_hours"] == 16.5 and day["active_fast"] is None, body)

    check("fast shows on the day it started and the day it ended",
          [f["id"] for f in json.loads(http(base, "GET", "/api/day?date=01/03/2026")[1])["day_fasts"]] == [fid]
          and [f["id"] for f in day["day_fasts"]] == [fid]
          and json.loads(http(base, "GET", "/api/day?date=03/03/2026")[1])["day_fasts"] == [])
    status, body = http(base, "PATCH", f"/api/fasts/{fid}", {"start_time": "18:30"})
    check("edit fast start", status == 200 and json.loads(body)["fast"]["hours"] == 18, body)
    status, body = http(base, "PATCH", f"/api/fasts/{fid}", {"end_time": None})
    check("edit fast rejects half-empty end", status == 400, body)

    status, body = http(base, "POST", "/api/fasts/start", {"date": "01/01/2099", "time": "10:00"})
    check("future fast start rejected", status == 400, body)

    status, body = http(base, "POST", "/api/fasts/start", {"date": "28/03/2026", "time": "22:00"})
    dst_id = json.loads(body)["fast"]["id"]
    status, body = http(base, "POST", "/api/fasts/stop", {"date": "29/03/2026", "time": "10:00"})
    check("fast hours across DST change", json.loads(body)["fast"]["hours"] == 11, body)

    status, body = http(base, "DELETE", f"/api/fasts/{dst_id}")
    check("delete fast", status == 200, body)
    status, body = http(base, "DELETE", f"/api/fasts/{dst_id}")
    check("delete fast twice is 404", status == 404, body)


def run_goal_checks(base):
    def day(d):
        return json.loads(http(base, "GET", f"/api/day?date={d}")[1])

    check("default goal is 20", day("20/03/2026")["goal"] == 20
          and day("20/03/2026")["goal_source"] == "default")
    # 01/03 has 20.5 g net carbs; 02/03 and 10/03 already have entries.
    status, body = http(base, "POST", "/api/goal", {"date": "01/03/2026", "net_carbs_goal": 30})
    res = json.loads(body)["day"]
    check("set goal for a day", status == 200 and res["goal"] == 30 and res["goal_source"] == "set"
          and res["remaining"] == 9.5 and res["over_goal"] is False, body)
    check("started later day keeps its goal", day("02/03/2026")["goal"] == 20
          and day("10/03/2026")["goal"] == 20)
    http(base, "POST", "/api/goal", {"date": "02/03/2026", "net_carbs_goal": 30})
    d = day("04/03/2026")
    check("unstarted later day carries the goal over", d["goal"] == 30 and d["goal_source"] == "inherited", d)
    check("carry-over stops at a started day", day("20/03/2026")["goal"] == 20)
    http(base, "POST", "/api/goal", {"date": "03/03/2026", "net_carbs_goal": 25})
    check("newer goal takes over from its day", day("04/03/2026")["goal"] == 25)
    http(base, "POST", "/api/goal", {"date": "03/03/2026", "net_carbs_goal": None})
    check("reset goal falls back to carried-over goal", day("03/03/2026")["goal"] == 30
          and day("04/03/2026")["goal"] == 30)
    status, body = http(base, "POST", "/api/goal", {"date": "01/03/2026", "net_carbs_goal": 0})
    check("reject goal of 0", status == 400, body)
    status, body = http(base, "GET", "/api/days?end=02/03/2026&n=3")
    o = json.loads(body)
    check("days overview: calendar days oldest first, empty days included", status == 200
          and [d["date"] for d in o["days"]] == ["28/02/2026", "01/03/2026", "02/03/2026"]
          and o["days"][0]["count"] == 0 and o["logged_days"] == 2 and o["within_goal_days"] == 2, body)
    check("streak counts consecutive days within goal", o["streak"]["current"] == 2
          and o["streak"]["best"] >= 2, o["streak"])
    status, body = http(base, "GET", "/api/days?end=03/03/2026")
    o = json.loads(body)
    check("days overview default 7; an unstarted end day does not break the streak",
          len(o["days"]) == 7 and o["streak"]["current"] == 2, o["streak"])
    rec = json.loads(http(base, "GET", "/api/recent?n=60")[1])
    check("recent uses per-day goals", {r["date"]: r["goal"] for r in rec}.get("01/03/2026") == 30, rec)


def run_note_checks(base):
    def req(method, path, obj=None):
        status, body = http(base, method, path, obj)
        return status, json.loads(body)

    d = "02/03/2026"
    status, res = req("POST", "/api/notes", {"date": d, "time": "09:30", "symptoms": ["Headache", " headache ", "כאב בטן"],
                                             "notes": "אחרי הקפה, mild"})
    nid = res.get("note", {}).get("id")
    check("add note: symptoms de-duplicated, Hebrew intact", status == 201 and res["note"]["symptoms"] == ["Headache", "כאב בטן"]
          and res["note"]["notes"] == "אחרי הקפה, mild" and res["note"]["source"] == "ui" and len(res["notes"]) == 1, res)
    status, res2 = req("POST", "/api/notes", {"date": d, "time": "08:00", "notes": "slept badly"})
    check("a note without symptoms; day lists notes by time", status == 201 and [n["time"] for n in res2["notes"]] == ["08:00", "09:30"], res2)
    check("reject an empty note", req("POST", "/api/notes", {"date": d, "symptoms": [], "notes": " "})[0] == 400
          and req("POST", "/api/notes", {"date": d, "symptoms": "x" * 41})[0] == 400
          and req("POST", "/api/notes", {"date": d, "symptoms": [1]})[0] == 400)
    day = req("GET", f"/api/day?date={d}")[1]
    check("day payload has notes and the symptom names used", len(day["notes"]) == 2 and day["symptom_names"] == ["Headache", "כאב בטן"], day["notes"])
    status, res = req("PATCH", f"/api/notes/{nid}", {"symptoms": ["Nausea"], "notes": None})
    check("update note", status == 200 and res["note"]["symptoms"] == ["Nausea"] and res["note"]["notes"] is None
          and res["note"]["time"] == "09:30", res)
    check("update cannot empty a note", req("PATCH", f"/api/notes/{nid}", {"symptoms": []})[0] == 400)
    ins = req("GET", "/api/insights")[1]
    row = next(x for x in ins["days"] if x["date"] == d)
    check("insights: symptoms per day and days per symptom", row["symptoms"] == ["Nausea"]
          and ins["summary"]["symptoms"] == [{"name": "Nausea", "days": 1, "last_date": d}], ins["summary"]["symptoms"])
    status, body = http(base, "GET", "/api/export.csv?table=notes")
    check("CSV export of notes", status == 200 and "02/03/2026" in body and "Nausea" in body and "slept badly" in body, body[:200])
    status, res = req("DELETE", f"/api/notes/{res2['note']['id']}")
    check("delete note", status == 200 and len(res["notes"]) == 1 and req("DELETE", "/api/notes/99999")[0] == 404, res)


def run_insights_checks(base):
    def get(path):
        status, body = http(base, "GET", path)
        return status, json.loads(body)

    today = db.format_date(db.today_iso())
    status, r = get("/api/insights")
    days = r["days"]
    first = json.loads(http(base, "GET", "/api/day")[1])["first_date"]
    isos = [db.parse_date(d["date"]) for d in days]
    check("insights: every calendar day from the first tracked day to today", status == 200
          and r["from"] == first == days[0]["date"] and r["to"] == today == days[-1]["date"]
          and all((date.fromisoformat(b) - date.fromisoformat(a)).days == 1 for a, b in zip(isos, isos[1:])),
          (r["from"], r["to"], len(days)))
    by = {d["date"]: d for d in days}
    ok = True
    for d in ("01/03/2026", "02/03/2026", "04/03/2026"):
        full = json.loads(http(base, "GET", f"/api/day?date={d}")[1])
        row = by[d]
        ok = ok and row["count"] == full["count"] and row["goal"] == full["goal"] \
            and row["over_goal"] == full["over_goal"] \
            and row["net_carbs_g"] == (full["totals"]["net_carbs_g"] if full["count"] else None) \
            and row["calories"] == full["totals"]["calories"] \
            and all(row[f] == full["body"][f] for f in db.MEASURE_FIELDS) and row["gki"] == full["body"]["gki"]
    check("insights: day rows match /api/day totals, goals and latest readings", ok, [by[d] for d in ("01/03/2026", "02/03/2026")])
    fasted = [d for d in days if d["fast_hours"]]
    full = json.loads(http(base, "GET", f"/api/day?date={fasted[0]['date']}")[1]) if fasted else None
    check("insights: fast hours are the fasts that ended that day, else the entries' hours",
          bool(fasted) and fasted[0]["fast_hours"] == (full["fast_hours"] or full["totals"]["fasting_hours"]), fasted[:1])
    s = r["summary"]
    logged = [d for d in days if d["count"] and d["date"] != today]
    check("insights: averages and days within goal over logged days",
          s["logged_days"] == len(logged)
          and s["within_goal_days"] == sum(1 for d in logged if not d["over_goal"])
          and abs(s["average"]["net_carbs_g"] - sum(d["net_carbs_g"] for d in logged) / len(logged)) < 0.01
          and sum(s["macro_pct"].values()) in (99, 100, 101) and "current" in s["streak"], s)
    w = s["measurements"]["weight_kg"]
    ws = [d["weight_kg"] for d in days if d["weight_kg"] is not None]
    check("insights: measurement stats", bool(ws) and w["days"] == len(ws) and w["first"] == ws[0]
          and w["last"] == ws[-1] and w["min"] == min(ws) and w["max"] == max(ws), w)
    foods = r["foods"]
    check("insights: foods ordered by net carbs, Hebrew intact",
          foods == sorted(foods, key=lambda x: -x["net_carbs_g"]) and len(foods) <= db.TOP_FOODS
          and any(any("\u05d0" <= c <= "\u05ea" for c in x["item"]) for x in foods) and all(0 <= x["share_pct"] <= 100 for x in foods), foods)

    status, body = http(base, "POST", "/api/entries", {"date": today, "item": "today so far", "net_carbs_g": 999})
    eid = json.loads(body)["created"][0]["id"]
    status, r7 = get("/api/insights?days=7")
    check("insights: days=7 is the last 7 days; today is charted but left out of the averages",
          len(r7["days"]) == 7 and r7["days"][-1]["net_carbs_g"] == 999 and r7["days"][-1]["over_goal"]
          and r7["summary"]["logged_days"] == 0 and r7["summary"]["average"]["net_carbs_g"] is None
          and r7["summary"]["macro_pct"] is None, r7["summary"])
    http(base, "DELETE", f"/api/entries/{eid}")
    check("insights: all and a huge range both start at the first tracked day",
          get("/api/insights?days=all")[1]["from"] == first and get("/api/insights?days=99999")[1]["from"] == first)
    check("insights: reject bad days", get("/api/insights?days=0")[0] == 400 and get("/api/insights?days=x")[0] == 400)


def run_body_checks(base):
    def post(obj):
        status, body = http(base, "POST", "/api/body", obj)
        return status, json.loads(body)

    post({"date": "01/03/2026", "weight_kg": 80})
    status, res = post({"date": "02/03/2026", "weight_kg": 79.4, "ketones_mmol": 1.5, "glucose_mmol": 4.5})
    b = res.get("body", {})
    check("body readings with weight change and GKI", status == 200 and b["weight_change_kg"] == -0.6
          and b["gki"] == 3 and b["gki_band"] == "moderate ketosis" and len(b["weights"]) == 2, res)
    post({"date": "02/03/2026", "add_water_ml": 250})
    status, res = post({"date": "02/03/2026", "add_water_ml": 250})
    check("water adds up, other readings unchanged", res["body"]["water_ml"] == 500
          and res["body"]["weight_kg"] == 79.4, res)
    status, res = post({"date": "02/03/2026", "add_water_ml": -1000})
    check("water never goes below 0", not res["body"]["water_ml"], res)
    status, res = post({"date": "02/03/2026", "weight_kg": 5})
    check("reject implausible weight", status == 400, res)
    status, res = post({"date": "02/03/2026", "water_ml": 1, "add_water_ml": 1})
    check("reject water_ml together with add_water_ml", status == 400, res)
    status, body = http(base, "GET", "/api/day?date=02/03/2026")
    check("day payload includes body readings", json.loads(body)["body"]["weight_kg"] == 79.4, body)

    def mpost(obj):
        status, body = http(base, "POST", "/api/measurements", obj)
        return status, json.loads(body)

    status, res = mpost({"date": "02/03/2026", "time": "07:00", "weight_kg": 79.0, "bp_sys": 121,
                         "bp_dia": 79, "pulse": 62, "notes": "אחרי ריצה"})
    mid = res.get("measurement", {}).get("id")
    b = res.get("body", {})
    check("add measurement: latest weight wins, BP and pulse, Hebrew note", status == 201
          and b["weight_kg"] == 79 and b["bp_sys"] == 121 and b["bp_dia"] == 79 and b["pulse"] == 62
          and b["ketones_mmol"] == 1.5 and res["measurement"]["notes"] == "אחרי ריצה"
          and len(b["measurements"]) == 2, res)
    status, res = mpost({"date": "02/03/2026", "time": "06:00", "weight_kg": 78.0})
    check("an earlier measurement does not replace the latest value",
          status == 201 and res["body"]["weight_kg"] == 79, res)
    status, res = mpost({"date": "02/03/2026", "bp_sys": 120})
    check("reject half a blood pressure", status == 400, res)
    status, res = mpost({"date": "02/03/2026", "notes": "nothing"})
    check("reject a measurement with no values", status == 400, res)
    status, body = http(base, "PATCH", f"/api/measurements/{mid}", {"weight_kg": None, "time": "08:30"})
    res = json.loads(body)
    check("update measurement clears a value", status == 200 and res["measurement"]["weight_kg"] is None
          and res["measurement"]["time"] == "08:30" and res["body"]["weight_kg"] == 78, res)
    status, body = http(base, "DELETE", f"/api/measurements/{mid}")
    res = json.loads(body)
    check("delete measurement", status == 200 and res["body"]["bp_sys"] is None
          and res["deleted"]["id"] == mid, res)
    status, body = http(base, "DELETE", f"/api/measurements/{mid}")
    check("delete unknown measurement is 404", status == 404, body)
    status, body = http(base, "GET", "/api/export.csv?table=measurements")
    check("CSV export of measurements", status == 200 and "02/03/2026" in body and "bp_sys" in body, body[:200])

    status, body = http(base, "GET", "/api/export.csv?table=entries")
    check("CSV export has DD/MM/YYYY dates and Hebrew", status == 200
          and "02/03/2026" in body and "גבינה צהובה" in body and body.lstrip("\ufeff").startswith("id,"), body[:200])
    status, body = http(base, "GET", "/api/export.csv?table=nope")
    check("CSV export rejects unknown table", status == 400, body)


SHEET_PASTE = (
    "תאריך\tשעה\tצום\tפריט\n"
    "10/03/2026\t10:00:00\t\tקפה Bulletproof\t20 גרם חמאה + 20 גרם שמן קוקוס\t310.0\t35.1\t0.2\t0.0\tצום שומן\n"
    "10/03/2026\t13:00:00\t16.0\tמיקס עלים ירוקים\t100 גרם\t22.0\t0.4\t1.9\t2.2\tתווית\n"
    "10/03/2026\t13:00:00\t\tטחינה גולמית\t50 גרם\t338.0\t28.0\t10.0\t4.0\t\n"
    '10/03/2026\t13:00:00\t16.0\tסה"כ ארוחת צהריים\t\t360.0\t28.4\t11.9\t6.2\tשבירת צום\n'
)


def run_import_checks(base):
    def imp(text, dry):
        status, body = http(base, "POST", "/api/import", {"text": text, "dry_run": dry})
        return status, json.loads(body)

    status, res = imp(SHEET_PASTE, True)
    check("import preview: header skipped, total row becomes the meal", status == 200
          and res["new"] == 3 and res["duplicates"] == 0 and not res["created"]
          and [t["meal"] for t in res["totals"]] == ["ארוחת צהריים"]
          and [r["meal"] for r in res["rows"]] == [None, "ארוחת צהריים", "ארוחת צהריים"]
          and res["rows"][1]["time"] == "13:00" and res["rows"][1]["fasting_hours"] == 16
          and res["rows"][0]["calories"] == 310 and res["rows"][0]["net_carbs_g"] == 0, res)
    status, body = http(base, "GET", "/api/day?date=10/03/2026")
    check("import preview writes nothing", json.loads(body)["count"] == 0, body)
    spaced = SHEET_PASTE.replace("\t", "    ")
    status, res = imp(spaced, False)
    check("import with tabs turned into spaces", status == 200 and len(res["created"]) == 3
          and all(r["source"] == "sheet" for r in res["created"]), res)
    status, body = http(base, "GET", "/api/day?date=10/03/2026")
    day = json.loads(body)
    check("imported day totals match the sheet's total row", day["totals"]["net_carbs_g"] == 6.2
          and day["totals"]["fasting_hours"] == 16, body)
    status, res = imp(SHEET_PASTE, False)
    check("pasting again skips duplicates", status == 200 and res["duplicates"] == 3
          and not res["created"], res)
    status, res = imp("10/03/2026\t25:00\t\tx\t\t\t\t\t1\n10/03/2026\t09:00\t\ty\t\t\t\t\t1", False)
    status2, body = http(base, "GET", "/api/day?date=10/03/2026")
    check("a bad row blocks the whole import", status == 400 and "line 1" in res["error"]
          and json.loads(body)["count"] == 3, res)
    status, res = imp("hello", True)
    check("import rejects text without date rows", status == 400, res)


def run_ai_checks(base):
    """The assistant against a fake OpenAI-style server: no real network."""
    from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
    fake = {"reply": "", "status": 200, "seen": []}

    class Fake(BaseHTTPRequestHandler):
        def do_POST(self):
            body = json.loads(self.rfile.read(int(self.headers["Content-Length"])).decode("utf-8"))
            fake["seen"].append({"path": self.path, "auth": self.headers.get("Authorization"), "body": body,
                                 "session": self.headers.get("x-opencode-session")})
            status = fake["status"]
            if fake.get("no_effort") and "reasoning_effort" in body:
                status = 400
            out = json.dumps({"choices": [{"message": {"role": "assistant", "content": fake["reply"]}}]}
                             if status == 200 else {"error": {"message": "unknown field reasoning_effort" if fake.get("no_effort") else "nope"}}).encode("utf-8")
            self.send_response(status)
            self.send_header("Content-Type", "application/json")
            self.send_header("Content-Length", str(len(out)))
            self.end_headers()
            self.wfile.write(out)

        def log_message(self, *a):
            pass

    def post(path, obj):
        status, body = http(base, "POST", path, obj)
        return status, json.loads(body)

    def count():
        return len(db.recent_days(60)), sum(d["count"] for d in db.recent_days(60))

    status, body = http(base, "GET", "/api/ai")
    check("assistant is off without a key", status == 200 and json.loads(body) == {"enabled": False, "model": None, "vision": False}, body)
    check("assistant calls answer 503 when off", post("/api/ai/food", {"text": "2 eggs"})[0] == 503
          and post("/api/ai/chat", {"messages": [{"role": "user", "content": "hi"}]})[0] == 503)

    httpd = ThreadingHTTPServer(("127.0.0.1", 0), Fake)
    threading.Thread(target=httpd.serve_forever, daemon=True).start()
    key = "sk-check-secret"
    os.environ.update(KETO_LLM_API_KEY=key, KETO_LLM_MODEL="fake-model",
                      KETO_LLM_BASE_URL=f"http://127.0.0.1:{httpd.server_address[1]}/v1")
    try:
        status, body = http(base, "GET", "/api/ai")
        check("assistant status shows the model, never the key", json.loads(body) == {"enabled": True, "model": "fake-model", "vision": False}
              and key not in body, body)

        before = count()
        heb = "גבינה צהובה"       # logged earlier in these checks
        fake["reply"] = "Sure!\n```json\n" + json.dumps({"rows": [
            {"item": heb, "quantity": "60 גרם", "net_carbs_g": "0,6", "calories": 210, "fat_g": 16.04, "protein_g": 15, "basis": "history"},
            {"item": "olives", "quantity": "10", "net_carbs_g": 0.5, "calories": 45, "fat_g": 4.5, "protein_g": 0.3, "basis": "history"},
            {"item": "", "net_carbs_g": 1},
            {"item": "no carbs given"},
            {"item": "nonsense", "net_carbs_g": -5},
        ], "question": None}, ensure_ascii=False) + "\n```"
        status, res = post("/api/ai/food", {"text": "60 גרם גבינה צהובה ו-10 זיתים"})
        rows = res.get("rows", [])
        check("food from words: fenced JSON read, rows cleaned, bad rows dropped", status == 200 and len(rows) == 2
              and res["dropped"] == 3 and rows[0] == {"item": heb, "quantity": "60 גרם", "net_carbs_g": 0.6,
                                                    "calories": 210.0, "fat_g": 16.0, "protein_g": 15.0, "basis": "history"}, res)
        check("food from words: 'history' only for foods really in the log", rows[1]["basis"] == "estimate", rows)
        sent = fake["seen"][-1]
        check("request: bearer key, model, chat path, known foods and Hebrew in the prompt",
              sent["auth"] == "Bearer " + key and sent["path"] == "/v1/chat/completions" and sent["body"]["model"] == "fake-model"
              and heb in sent["body"]["messages"][0]["content"] and "זיתים" in sent["body"]["messages"][1]["content"], sent["path"])
        check("food from words writes nothing", count() == before)

        fake["reply"] = '{"rows": [], "question": "What did you eat?"}'
        status, res = post("/api/ai/food", {"text": "something"})
        check("food: a question instead of rows", status == 200 and res["rows"] == [] and res["question"] == "What did you eat?", res)
        fake["reply"] = "I cannot help with that."
        check("food: an answer without JSON is 502", post("/api/ai/food", {"text": "x"})[0] == 502)
        check("food: empty request is 400", post("/api/ai/food", {"text": "  "})[0] == 400)
        img = "data:image/jpeg;base64,/9j/4AAQSkZJRg=="
        status, res = post("/api/ai/food", {"image": img})
        check("photo without a vision model is 503", status == 503, res)
        os.environ["KETO_LLM_VISION_MODEL"] = "fake-vision"
        fake["reply"] = '{"rows": [{"item": "bar", "quantity": "1 (40 g)", "net_carbs_g": 3, "calories": 190, "fat_g": 15, "protein_g": 8, "basis": "label"}]}'
        status, res = post("/api/ai/food", {"image": img})
        parts = fake["seen"][-1]["body"]["messages"][1]["content"]
        check("photo goes to the vision model as an image part", status == 200 and res["rows"][0]["basis"] == "label"
              and fake["seen"][-1]["body"]["model"] == "fake-vision" and parts[1]["image_url"]["url"] == img, res)
        check("photo must be an image data URL", post("/api/ai/food", {"image": "https://example.com/x.jpg"})[0] == 400)

        fake["reply"] = ("You have room for it. **Go ahead.**\nLOG: " + json.dumps({"rows": [
            {"item": "avocado", "quantity": "100 g", "net_carbs_g": 1.8, "calories": 160, "fat_g": 15, "protein_g": 2}]}))
        status, res = post("/api/ai/chat", {"messages": [{"role": "user", "content": "log half an avocado"}]})
        check("coach: reply text and proposed rows, nothing written", status == 200 and res["reply"] == "You have room for it. Go ahead."
              and res["rows"][0]["item"] == "avocado" and res["rows"][0]["basis"] == "estimate" and count() == before, res)
        system = fake["seen"][-1]["body"]["messages"][0]["content"]
        check("coach sees the log", "LOG DATA" in system and "net_carbs_goal_g" in system and "KNOWN FOODS" in system)
        fake["reply"] = "Plain advice."
        status, res = post("/api/ai/chat", {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"},
                                                         {"role": "user", "content": "c"}]})
        check("coach: plain reply, thread passed on", status == 200 and res == {"reply": "Plain advice.", "rows": []}
              and [m["role"] for m in fake["seen"][-1]["body"]["messages"]] == ["system", "user", "assistant", "user"], res)
        first = fake["seen"][-1]["session"]
        post("/api/ai/chat", {"messages": [{"role": "user", "content": "a"}, {"role": "assistant", "content": "b"},
                                           {"role": "user", "content": "c"}, {"role": "assistant", "content": "d"},
                                           {"role": "user", "content": "e"}]})
        post("/api/ai/chat", {"messages": [{"role": "user", "content": "another chat"}]})
        check("a session id is sent, the same through one chat and new for another", bool(first)
              and fake["seen"][-2]["session"] == first and fake["seen"][-1]["session"] != first)
        check("coach: last message must be the user's",
              post("/api/ai/chat", {"messages": [{"role": "assistant", "content": "b"}]})[0] == 400
              and post("/api/ai/chat", {"messages": []})[0] == 400)

        fake["reply"] = "Good period."
        n = len(fake["seen"])
        status, res = post("/api/ai/summary", {"days": "all"})
        again = post("/api/ai/summary", {"days": "all"})[1]
        check("review: text for the range, same numbers answered from cache", status == 200 and res["text"] == "Good period."
              and res["model"] == "fake-model" and again == res and len(fake["seen"]) == n + 1, res)
        check("review: refresh asks again", post("/api/ai/summary", {"days": "all", "refresh": True})[0] == 200
              and len(fake["seen"]) == n + 2)
        check("review: no full logged day is 400", post("/api/ai/summary", {"days": 3})[0] == 400)

        fake["no_effort"] = True
        n = len(fake["seen"])
        status, res = post("/api/ai/chat", {"messages": [{"role": "user", "content": "hi"}]})
        check("a model that refuses reasoning_effort is asked again without it", status == 200 and len(fake["seen"]) == n + 2
              and fake["seen"][-2]["body"].get("reasoning_effort") == "low" and "reasoning_effort" not in fake["seen"][-1]["body"], res)
        fake["no_effort"] = False
        fake["status"] = 429
        status, res = post("/api/ai/chat", {"messages": [{"role": "user", "content": "hi"}]})
        check("upstream error becomes 502 with a reason, no key", status == 502 and "rate limited" in res["error"]
              and key not in json.dumps(res), res)
        fake["status"] = 200
        os.environ["KETO_LLM_BASE_URL"] = "http://example.com/v1"
        check("plain http to another host is refused", post("/api/ai/chat", {"messages": [{"role": "user", "content": "hi"}]})[0] == 503)
    finally:
        for k in ("KETO_LLM_API_KEY", "KETO_LLM_BASE_URL", "KETO_LLM_MODEL", "KETO_LLM_VISION_MODEL"):
            os.environ.pop(k, None)
        httpd.shutdown()
        httpd.server_close()


def check_body_migration():
    """Old daily readings in body_log move to measurements; water stays."""
    conn = db.connect()
    with conn:
        conn.execute("INSERT INTO body_log (log_date, weight_kg, glucose_mmol, water_ml, updated_at)"
                     " VALUES ('2026-02-01', 83.5, 5.1, 750, 'x'), ('2026-02-02', 83.2, NULL, NULL, 'x')")
    conn.close()
    conn = db.connect()
    rows = [tuple(r) for r in conn.execute(
        "SELECT m_date, m_time, weight_kg, glucose_mmol FROM measurements"
        " WHERE m_date < '2026-03-01' ORDER BY m_date")]
    water = [tuple(r) for r in conn.execute("SELECT log_date, weight_kg, water_ml FROM body_log WHERE log_date < '2026-03-01'")]
    conn.close()
    db.connect().close()  # running again changes nothing
    again = db.get_day("01/02/2026")["body"]
    check("legacy body readings migrate to measurements",
          rows == [("2026-02-01", None, 83.5, 5.1), ("2026-02-02", None, 83.2, None)]
          and water == [("2026-02-01", None, 750)] and len(again["measurements"]) == 1
          and again["weight_kg"] == 83.5 and again["water_ml"] == 750, (rows, water, again))


def run_mcp_checks():
    proc = subprocess.Popen(
        [sys.executable, os.path.join(HERE, "mcp_server.py")],
        stdin=subprocess.PIPE, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        env=dict(os.environ),
    )

    def send(obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        proc.stdin.write(b"Content-Length: %d\r\n\r\n" % len(body) + body)
        proc.stdin.flush()

    def recv():
        headers = {}
        while True:
            line = proc.stdout.readline()
            if not line:
                raise RuntimeError("MCP server closed stdout")
            line = line.strip()
            if not line:
                break
            k, _, v = line.decode("ascii").partition(":")
            headers[k.strip().lower()] = v.strip()
        return json.loads(proc.stdout.read(int(headers["content-length"])).decode("utf-8"))

    try:
        send({"jsonrpc": "2.0", "id": 1, "method": "initialize",
              "params": {"protocolVersion": "2024-11-05", "capabilities": {},
                         "clientInfo": {"name": "check", "version": "0"}}})
        r = recv()
        check("MCP initialize (framed)", r.get("id") == 1 and "tools" in r.get("result", {}).get("capabilities", {}), r)
        send({"jsonrpc": "2.0", "method": "notifications/initialized"})

        send({"jsonrpc": "2.0", "id": 2, "method": "tools/list"})
        r = recv()
        names = sorted(t["name"] for t in r.get("result", {}).get("tools", []))
        check("MCP tools/list", names == ["add_entries", "add_measurement", "add_note", "delete_entry", "delete_fast",
                                          "delete_measurement", "delete_note", "get_day", "log_body", "recent_days",
                                          "set_goal", "start_fast", "stop_fast", "update_entry",
                                          "update_fast", "update_measurement"], r)

        send({"jsonrpc": "2.0", "id": 3, "method": "tools/call", "params": {
            "name": "add_entries",
            "arguments": {"entries": [{"date": "05/03/2026", "time": "19:30",
                                       "item": "סלמון", "net_carbs_g": 0.5, "calories": 300}]}}})
        r = recv()
        res = r.get("result", {})
        payload = json.loads(res["content"][0]["text"]) if res.get("content") else {}
        check("MCP add_entries", res.get("isError") is False
              and payload["created"][0]["source"] == "mcp"
              and payload["created"][0]["item"] == "סלמון"
              and payload["days"]["05/03/2026"]["totals"]["net_carbs_g"] == 0.5, r)

        send({"jsonrpc": "2.0", "id": 4, "method": "tools/call", "params": {
            "name": "add_entries", "arguments": {"entries": [{"item": "x"}]}}})
        r = recv()
        check("MCP add_entries rejects missing net carbs", r.get("result", {}).get("isError") is True, r)

        send({"jsonrpc": "2.0", "id": 5, "method": "ping"})
        check("MCP ping", recv().get("result") == {})

        day = db.get_day("05/03/2026")
        check("MCP row visible in shared temp db", day["count"] == 1 and day["entries"][0]["source"] == "mcp")

        def call(rid, name, args):
            send({"jsonrpc": "2.0", "id": rid, "method": "tools/call",
                  "params": {"name": name, "arguments": args}})
            res = recv().get("result", {})
            return res.get("isError"), json.loads(res["content"][0]["text"]) if not res.get("isError") else res

        eid = day["entries"][0]["id"]
        err, out = call(6, "update_entry", {"id": eid, "net_carbs_g": 2})
        check("MCP update_entry", err is False and out["days"]["05/03/2026"]["totals"]["net_carbs_g"] == 2, out)
        err, out = call(7, "start_fast", {"date": "06/03/2026", "time": "20:00"})
        check("MCP start_fast", err is False and out["fast"]["source"] == "mcp", out)
        err, out = call(8, "stop_fast", {"date": "07/03/2026", "time": "14:00"})
        check("MCP stop_fast", err is False and out["fast"]["hours"] == 18, out)
        err, out = call(11, "set_goal", {"date": "05/03/2026", "net_carbs_goal": 1})
        check("MCP set_goal", err is False and out["goal"] == 1 and out["over_goal"] is True, out)
        err, out = call(12, "log_body", {"date": "05/03/2026", "weight_kg": 81, "add_water_ml": 300})
        check("MCP log_body", err is False and out["weight_kg"] == 81 and out["water_ml"] == 300, out)
        err, out = call(13, "add_measurement", {"date": "05/03/2026", "time": "07:10",
                                                "bp_sys": 118, "bp_dia": 76, "pulse": 58})
        mid = out.get("measurement", {}).get("id") if isinstance(out, dict) else None
        check("MCP add_measurement", err is False and out["measurement"]["source"] == "mcp"
              and out["body"]["bp_sys"] == 118 and out["body"]["weight_kg"] == 81, out)
        err, out = call(14, "update_measurement", {"id": mid, "pulse": 61})
        check("MCP update_measurement", err is False and out["measurement"]["pulse"] == 61, out)
        err, out = call(15, "delete_measurement", {"id": mid})
        check("MCP delete_measurement", err is False and out["body"]["bp_sys"] is None, out)
        err, out = call(16, "add_note", {"date": "05/03/2026", "symptoms": ["Tiredness"], "notes": "עייף"})
        check("MCP add_note", err is False and out["note"]["source"] == "mcp" and out["note"]["notes"] == "עייף"
              and db.get_day("05/03/2026")["notes"][0]["symptoms"] == ["Tiredness"], out)
        err, out = call(17, "delete_note", {"id": out["note"]["id"]})
        check("MCP delete_note", err is False and out["notes"] == [], out)
        err, out = call(9, "delete_entry", {"id": eid})
        check("MCP delete_entry", err is False and out["day"]["count"] == 0, out)
        err, out = call(10, "delete_entry", {"id": eid})
        check("MCP delete_entry unknown id is a tool error", err is True, out)
    finally:
        proc.stdin.close()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()


def main():
    before = real_db_state()
    check("using temp db, not data/keto.sqlite",
          os.path.abspath(db.db_path()) != os.path.abspath(REAL_DB))
    try:
        run_http_checks()
        run_mcp_checks()
        check_body_migration()
    except Exception as e:  # a crash is a failure, not a pass
        failures.append(f"exception: {e!r}")
        print(f"FAIL exception: {e!r}")
    check("data/keto.sqlite untouched", real_db_state() == before)
    tmpdir.cleanup()
    print()
    if failures:
        print(f"{len(failures)} check(s) failed")
        return 1
    print("all checks passed")
    return 0


if __name__ == "__main__":
    sys.exit(main())
