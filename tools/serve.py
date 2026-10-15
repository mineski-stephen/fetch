#!/usr/bin/env python3
"""
Serve the Fetch page (project root) locally for testing, with caching disabled so browsers always load
the latest files (Python's plain http.server lets browsers keep stale copies).

    python tools/serve.py          # http://127.0.0.1:9124/  (Fetch's port; register it on the Lark app)
    python tools/serve.py 9000

Always 127.0.0.1, never "localhost": they are different origins, with different storage and different
redirect URLs on the Lark app.
"""
import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")   # index.html lives in the project root
PORT = 9124


class NoCache(SimpleHTTPRequestHandler):
    # Module scripts refuse to run unless served as JavaScript; a Windows registry
    # entry can make Python guess "text/plain" for .js, so set the types here.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".css": "text/css", ".webmanifest": "application/manifest+json"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    handler = functools.partial(NoCache, directory=os.path.normpath(WEB))
    print(f"Serving {os.path.normpath(WEB)} at http://127.0.0.1:{port}/ (no caching)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
