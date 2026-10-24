#!/usr/bin/env python3

import json
import os
import re
import subprocess
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

UNIT = "hive-worker.service"
PORT = 3471
ENV = {
    **os.environ,
    "XDG_RUNTIME_DIR": f"/run/user/{os.getuid()}",
    "DBUS_SESSION_BUS_ADDRESS": f"unix:path=/run/user/{os.getuid()}/bus",
}
ALLOW = re.compile(
    r"^http://(127\.0\.0\.1|localhost):3470$"
)


def run(args):
    try:
        return subprocess.run(args, env=ENV, capture_output=True, text=True, timeout=25)
    except Exception as e:
        return None


def is_on():
    r = run(["systemctl", "--user", "is-active", UNIT])
    return bool(r and r.stdout.strip() == "active")


def set_on(on):
    run(["systemctl", "--user", "start" if on else "stop", UNIT])
    return is_on()


class Handler(BaseHTTPRequestHandler):
    def _cors(self):
        origin = self.headers.get("Origin", "")
        if ALLOW.match(origin):
            self.send_header("Access-Control-Allow-Origin", origin)
            self.send_header("Vary", "Origin")

    def _send(self, code, obj):
        body = json.dumps(obj).encode()
        self.send_response(code)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "no-store")
        self._cors()
        self.send_header("Content-Length", str(len(body)))
        self.end_headers()
        self.wfile.write(body)

    def do_OPTIONS(self):
        self.send_response(204)
        self._cors()
        self.send_header("Access-Control-Allow-Methods", "GET, POST, OPTIONS")
        self.send_header("Access-Control-Allow-Headers", "content-type")
        self.end_headers()

    def do_GET(self):
        if self.path.split("?")[0] == "/state":
            return self._send(200, {"on": is_on()})
        return self._send(404, {"error": "not found"})

    def do_POST(self):
        path = self.path.split("?")[0]
        if path == "/toggle":
            return self._send(200, {"on": set_on(not is_on())})
        if path == "/on":
            return self._send(200, {"on": set_on(True)})
        if path == "/off":
            return self._send(200, {"on": set_on(False)})
        return self._send(404, {"error": "not found"})

    def log_message(self, *args):
        pass


if __name__ == "__main__":
    ThreadingHTTPServer(("0.0.0.0", PORT), Handler).serve_forever()
