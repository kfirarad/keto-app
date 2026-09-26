"""Self-check for the keto tracker.

Runs against a temporary database (KETO_DB) and an in-process HTTP server on
an ephemeral loopback port, so it works whether keto.service is running or
not and never touches data/keto.sqlite. Exit code 0 means all checks passed.
"""

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
    check("water never goes below 0", res["body"]["water_ml"] == 0, res)
    status, res = post({"date": "02/03/2026", "weight_kg": 5})
    check("reject implausible weight", status == 400, res)
    status, res = post({"date": "02/03/2026", "water_ml": 1, "add_water_ml": 1})
    check("reject water_ml together with add_water_ml", status == 400, res)
    status, body = http(base, "GET", "/api/day?date=02/03/2026")
    check("day payload includes body readings", json.loads(body)["body"]["weight_kg"] == 79.4, body)

    status, body = http(base, "GET", "/api/export.csv?table=entries")
    check("CSV export has DD/MM/YYYY dates and Hebrew", status == 200
          and "02/03/2026" in body and "גבינה צהובה" in body and body.lstrip("\ufeff").startswith("id,"), body[:200])
    status, body = http(base, "GET", "/api/export.csv?table=nope")
    check("CSV export rejects unknown table", status == 400, body)


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
        check("MCP tools/list", names == ["add_entries", "delete_entry", "delete_fast", "get_day",
                                          "log_body", "recent_days", "set_goal", "start_fast", "stop_fast",
                                          "update_entry", "update_fast"], r)

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
