"""Keto tracker web process. Listens on 127.0.0.1:8787 only."""

import json
import os
import re
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import assistant
import db
import llm

HOST = "127.0.0.1"
PORT = 8787
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MAX_BODY = 1024 * 1024
MAX_PHOTO_BODY = 4 * 1024 * 1024     # /api/ai/food carries a downscaled photo

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/static/app.css": ("app.css", "text/css; charset=utf-8"),
    "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
}


ENTRY_PATH = re.compile(r"^/api/entries/(\d+)$")
FAST_PATH = re.compile(r"^/api/fasts/(\d+)$")
MEASURE_PATH = re.compile(r"^/api/measurements/(\d+)$")
NOTE_PATH = re.compile(r"^/api/notes/(\d+)$")


class HTTPError(Exception):
    def __init__(self, status, message):
        super().__init__(message)
        self.status = status
        self.message = message


class Handler(BaseHTTPRequestHandler):
    server_version = "keto/1"

    def _send(self, status, body, content_type):
        self.send_response(status)
        self.send_header("Content-Type", content_type)
        self.send_header("Content-Length", str(len(body)))
        self.send_header("Cache-Control", "no-store")
        self.send_header("X-Content-Type-Options", "nosniff")
        self.end_headers()
        if self.command != "HEAD":
            self.wfile.write(body)

    def _json(self, status, obj):
        body = json.dumps(obj, ensure_ascii=False).encode("utf-8")
        self._send(status, body, "application/json; charset=utf-8")

    def _dispatch(self, fn):
        try:
            fn()
        except HTTPError as e:
            self._json(e.status, {"error": e.message})
        except db.NotFoundError as e:
            self._json(404, {"error": str(e)})
        except db.ConflictError as e:
            self._json(409, {"error": str(e)})
        except db.ValidationError as e:
            self._json(400, {"error": str(e)})
        except llm.LLMError as e:
            self._json(e.status, {"error": str(e)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._json(500, {"error": "internal server error"})

    def do_GET(self):
        self._dispatch(self._get)

    def do_HEAD(self):
        self._dispatch(self._get)

    def do_POST(self):
        self._dispatch(self._post)

    def do_PATCH(self):
        self._dispatch(self._patch)

    def do_DELETE(self):
        self._dispatch(self._delete)

    def do_PUT(self):
        self._dispatch(self._not_allowed)

    def _not_allowed(self):
        raise HTTPError(405, f"method {self.command} not allowed")

    def _get(self):
        url = urlparse(self.path)
        qs = parse_qs(url.query)
        if url.path in STATIC_FILES:
            name, ctype = STATIC_FILES[url.path]
            with open(os.path.join(STATIC_DIR, name), "rb") as f:
                self._send(200, f.read(), ctype)
        elif url.path == "/api/day":
            self._json(200, db.get_day(qs.get("date", [None])[0]))
        elif url.path == "/api/recent":
            self._json(200, db.recent_days(qs.get("n", [None])[0]))
        elif url.path == "/api/foods":
            top = qs.get("top", [None])[0]
            self._json(200, db.recent_foods() if top is None else db.frequent_foods(top))
        elif url.path == "/api/days":
            self._json(200, db.days_overview(qs.get("end", [None])[0], qs.get("n", [None])[0]))
        elif url.path == "/api/ai":
            self._json(200, llm.status())
        elif url.path == "/api/insights":
            self._json(200, db.insights(qs.get("days", [None])[0]))
        elif url.path == "/api/export.csv":
            table = qs.get("table", ["entries"])[0]
            body = ("\ufeff" + db.export_csv(table)).encode("utf-8")  # BOM so Excel reads Hebrew
            self.send_response(200)
            self.send_header("Content-Type", "text/csv; charset=utf-8")
            self.send_header("Content-Disposition", f'attachment; filename="keto-{table}.csv"')
            self.send_header("Content-Length", str(len(body)))
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                self.wfile.write(body)
        elif url.path == "/api/meals":
            self._json(200, db.meal_names())
        elif url.path == "/api/entries" or ENTRY_PATH.match(url.path) or url.path.startswith("/api/fasts") or url.path.startswith("/api/measurements") or url.path in ("/api/goal", "/api/body", "/api/import"):
            raise HTTPError(405, f"GET not allowed on {url.path}")
        else:
            raise HTTPError(404, f"not found: {url.path}")

    def _post(self):
        path = urlparse(self.path).path
        if path == "/api/entries":
            created, days = db.add_entries(self._read_json(), source="ui")
            first_date = created[0]["date"]
            self._json(201, {"created": created, "day": days[first_date], "days": days})
        elif path == "/api/entries/restore":
            row, day = db.restore_entry(self._read_json())
            self._json(201, {"entry": row, "day": day})
        elif path == "/api/fasts/start":
            self._json(201, {"fast": db.start_fast(self._read_json(allow_empty=True), source="ui")})
        elif path == "/api/fasts/stop":
            self._json(200, {"fast": db.stop_fast(self._read_json(allow_empty=True))})
        elif path == "/api/body":
            self._json(200, {"body": db.log_body(self._read_json())})
        elif path == "/api/goal":
            self._json(200, {"day": db.set_goal(self._read_json())})
        elif path == "/api/measurements":
            row, body = db.add_measurement(self._read_json(), source="ui")
            self._json(201, {"measurement": row, "body": body})
        elif path == "/api/notes":
            row, notes = db.add_note(self._read_json(), source="ui")
            self._json(201, {"note": row, "notes": notes})
        elif path == "/api/import":
            payload = self._read_json()
            if not isinstance(payload, dict):
                raise db.ValidationError("body must be {text, dry_run}")
            self._json(200, db.import_sheet(payload.get("text"), bool(payload.get("dry_run"))))
        elif path == "/api/ai/food":
            self._json(200, assistant.parse_food(self._read_json(limit=MAX_PHOTO_BODY)))
        elif path == "/api/ai/chat":
            self._json(200, assistant.chat(self._read_json()))
        elif path == "/api/ai/summary":
            self._json(200, assistant.summary(self._read_json()))
        elif path in STATIC_FILES or path.startswith("/api/"):
            raise HTTPError(405, f"POST not allowed on {path}")
        else:
            raise HTTPError(404, f"not found: {path}")

    def _patch(self):
        path = urlparse(self.path).path
        m = ENTRY_PATH.match(path)
        if m:
            row, days = db.update_entry(int(m.group(1)), self._read_json())
            self._json(200, {"entry": row, "day": days[row["date"]], "days": days})
            return
        m = FAST_PATH.match(path)
        if m:
            self._json(200, {"fast": db.update_fast(int(m.group(1)), self._read_json())})
            return
        m = MEASURE_PATH.match(path)
        if m:
            row, body = db.update_measurement(int(m.group(1)), self._read_json())
            self._json(200, {"measurement": row, "body": body})
            return
        m = NOTE_PATH.match(path)
        if m:
            row, notes = db.update_note(int(m.group(1)), self._read_json())
            self._json(200, {"note": row, "notes": notes})
            return
        self._not_allowed()

    def _delete(self):
        path = urlparse(self.path).path
        m = ENTRY_PATH.match(path)
        if m:
            row, day = db.delete_entry(int(m.group(1)))
            self._json(200, {"deleted": row, "day": day})
            return
        m = FAST_PATH.match(path)
        if m:
            self._json(200, {"deleted": db.delete_fast(int(m.group(1)))})
            return
        m = MEASURE_PATH.match(path)
        if m:
            row, body = db.delete_measurement(int(m.group(1)))
            self._json(200, {"deleted": row, "body": body})
            return
        m = NOTE_PATH.match(path)
        if m:
            row, notes = db.delete_note(int(m.group(1)))
            self._json(200, {"deleted": row, "notes": notes})
            return
        self._not_allowed()

    def _read_json(self, allow_empty=False, limit=MAX_BODY):
        length_hdr = self.headers.get("Content-Length")
        if allow_empty and (length_hdr is None or length_hdr.strip() == "0"):
            return {}
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise HTTPError(415, "Content-Type must be application/json")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise HTTPError(411, "Content-Length required")
        if length < 0 or length > limit:
            raise HTTPError(413, "request body too large")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HTTPError(400, "body is not valid UTF-8 JSON")
        return payload

    def log_message(self, fmt, *args):
        sys.stderr.write("%s - %s\n" % (self.address_string(), fmt % args))


def make_server(host=HOST, port=PORT):
    db.connect().close()  # create schema / enable WAL up front
    return ThreadingHTTPServer((host, port), Handler)


def main():
    httpd = make_server()
    sys.stderr.write(f"keto listening on http://{HOST}:{PORT}/ db={db.db_path()}\n")
    try:
        httpd.serve_forever()
    except KeyboardInterrupt:
        pass
    finally:
        httpd.server_close()


if __name__ == "__main__":
    main()
