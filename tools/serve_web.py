#!/usr/bin/env python3
"""
Serve the Fetch page (project root) locally for testing, with caching disabled so browsers always load
the latest files (Python's plain http.server lets browsers keep stale copies).

    python tools/serve_web.py          # http://localhost:8770
    python tools/serve_web.py 9000
"""
import functools
import os
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")   # index.html lives in the project root


class NoCache(SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()


if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 8770
    handler = functools.partial(NoCache, directory=os.path.normpath(WEB))
    print(f"Serving {os.path.normpath(WEB)} at http://localhost:{port} (no caching)", flush=True)
    ThreadingHTTPServer(("127.0.0.1", port), handler).serve_forever()
