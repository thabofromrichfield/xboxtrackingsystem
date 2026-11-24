#!/usr/bin/env python3
"""
Tiny zero-dependency dev server for the Xbox Tracking System.

Mirrors the production Vercel routing (extensionless /camera -> camera.html),
sends the headers a camera page needs, and disables caching so edits show up
immediately. No build step in this project on purpose: the app is native ES
modules, so what you run locally is byte-for-byte what gets deployed.

    python3 tools/serve.py [port]        # default 5173
"""

from __future__ import annotations

import http.server
import os
import socketserver
import sys
from pathlib import Path

ROOT = Path(__file__).resolve().parent.parent
ROUTES = {"/": "/index.html", "/camera": "/camera.html", "/index": "/index.html"}


class Handler(http.server.SimpleHTTPRequestHandler):
    def __init__(self, *args, **kwargs):
        super().__init__(*args, directory=str(ROOT), **kwargs)

    def translate_path(self, path: str) -> str:
        clean = path.split("?", 1)[0].split("#", 1)[0]
        if clean in ROUTES:
            path = path.replace(clean, ROUTES[clean], 1)
        elif "." not in Path(clean).name:
            guess = f"{clean}.html"
            if (ROOT / guess.lstrip("/")).exists():
                path = path.replace(clean, guess, 1)
        return super().translate_path(path)

    def end_headers(self) -> None:
        self.send_header("cache-control", "no-store")
        # getUserMedia needs a secure context; over http://localhost it is allowed
        # by browsers, and these headers keep the dev experience close to https.
        self.send_header("x-content-type-options", "nosniff")
        self.send_header("referrer-policy", "strict-origin-when-cross-origin")
        if self.path.startswith("/api/"):
            self.send_header("access-control-allow-origin", "*")
        super().end_headers()

    def do_POST(self) -> None:  # noqa: N802 - emulate api/event locally
        if not self.path.startswith("/api/event"):
            self.send_error(404, "local dev server only emulates POST /api/event")
            return
        length = int(self.headers.get("content-length") or 0)
        raw = self.rfile.read(length).decode("utf-8", "ignore")
        try:
            import json as _json

            body = _json.loads(raw or "{}")
        except Exception as exc:  # noqa: BLE001
            self._json(400, {"error": f"invalid json: {exc}"})
            return
        token = self.headers.get("x-xbox-token") or body.get("token") or ""
        if not token:
            self._json(401, {"error": "missing x-xbox-token"})
            return
        self._json(
            201,
            {
                "ok": True,
                "local_only": True,
                "hint": "dev server only echoes this payload; the deployed /api/event on Vercel writes to Supabase",
                "echo": {k: v for k, v in body.items() if k != "snapshot"},
            },
        )

    def _json(self, code: int, payload: dict) -> None:
        data = __import__("json").dumps(payload).encode()
        self.send_response(code)
        self.send_header("content-type", "application/json")
        self.send_header("content-length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def log_message(self, fmt: str, *args) -> None:
        sys.stderr.write("  %s - %s\n" % (self.address_string(), fmt % args))


def main() -> int:
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 5173
    socketserver.TCPServer.allow_reuse_address = True
    with socketserver.TCPServer(("0.0.0.0", port), Handler) as httpd:
        print(f"xbox tracking system — serving {ROOT}")
        print(f"  control center : http://localhost:{port}/")
        print(f"  camera node    : http://localhost:{port}/camera")
        print(f"  ingest (mock)  : POST http://localhost:{port}/api/event")
        try:
            httpd.serve_forever()
        except KeyboardInterrupt:
            print("\nstopped")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
