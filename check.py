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
    finally:
        httpd.shutdown()
        httpd.server_close()


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
        check("MCP tools/list", names == ["add_entries", "get_day", "recent_days"], r)

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
