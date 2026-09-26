"""Keto tracker web process. Listens on 127.0.0.1:8787 only."""

import json
import os
import sys
import traceback
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import parse_qs, urlparse

import db

HOST = "127.0.0.1"
PORT = 8787
STATIC_DIR = os.path.join(os.path.dirname(os.path.abspath(__file__)), "static")
MAX_BODY = 1024 * 1024

STATIC_FILES = {
    "/": ("index.html", "text/html; charset=utf-8"),
    "/static/app.css": ("app.css", "text/css; charset=utf-8"),
    "/static/app.js": ("app.js", "text/javascript; charset=utf-8"),
}


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
        except db.ValidationError as e:
            self._json(400, {"error": str(e)})
        except Exception:
            traceback.print_exc(file=sys.stderr)
            self._json(500, {"error": "internal server error"})

    def do_GET(self):
        self._dispatch(self._get)

    def do_HEAD(self):
        self._dispatch(self._get)

    def do_POST(self):
        self._dispatch(self._post)

    def do_PUT(self):
        self._dispatch(self._not_allowed)

    do_DELETE = do_PATCH = do_PUT

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
        elif url.path == "/api/entries":
            raise HTTPError(405, "use POST for /api/entries")
        else:
            raise HTTPError(404, f"not found: {url.path}")

    def _post(self):
        url = urlparse(self.path)
        if url.path != "/api/entries":
            if url.path in STATIC_FILES or url.path.startswith("/api/"):
                raise HTTPError(405, f"POST not allowed on {url.path}")
            raise HTTPError(404, f"not found: {url.path}")
        ctype = self.headers.get("Content-Type", "").split(";")[0].strip().lower()
        if ctype != "application/json":
            raise HTTPError(415, "Content-Type must be application/json")
        try:
            length = int(self.headers.get("Content-Length", ""))
        except ValueError:
            raise HTTPError(411, "Content-Length required")
        if length < 0 or length > MAX_BODY:
            raise HTTPError(413, "request body too large")
        raw = self.rfile.read(length)
        try:
            payload = json.loads(raw.decode("utf-8"))
        except (UnicodeDecodeError, json.JSONDecodeError):
            raise HTTPError(400, "body is not valid UTF-8 JSON")
        created, days = db.add_entries(payload, source="ui")
        first_date = created[0]["date"]
        self._json(201, {"created": created, "day": days[first_date], "days": days})

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
