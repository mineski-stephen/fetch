#!/usr/bin/env python3
"""
Serve a Mineski tool (the folder holding index.html) locally for testing, with caching disabled so
browsers always load the latest files (Python's plain http.server lets browsers keep stale copies) and
with explicit JavaScript types (some Windows machines serve .js as text/plain, and module scripts then
refuse to run).

Copy this file to <tool>/tools/serve.py and set PORT to the tool's port from the registry in
mineski-systems-design (section 8.3); register http://127.0.0.1:<PORT>/ on the Lark app.

    python tools/serve.py          # http://127.0.0.1:<PORT>/
    python tools/serve.py 9200     # another port

Always 127.0.0.1, never "localhost": they are different origins, with different storage and different
redirect URLs on the Lark app.

Two safeguards:
- It refuses to start when the port is already taken, and says so. (Python's server normally asks for
  SO_REUSEADDR, which on Windows lets a second server share a port that's in use; requests then go to
  whichever one Windows picks, often an old one, and the browser gets "didn't send any data".)
- It keeps serving if the window or terminal it was started from goes away. (Each request is logged
  to that console; with the console gone, the log write used to fail and every request got an empty
  answer.)
"""
import errno
import functools
import os
import socket
import sys
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

WEB = os.path.join(os.path.dirname(os.path.abspath(__file__)), "..")   # index.html lives in the tool's root
PORT = 9124   # fetch's registered port


def say(text):
    """Print to the console if there still is one; a missing console never stops the server."""
    try:
        print(text, file=sys.stderr, flush=True)
    except (OSError, ValueError, AttributeError):
        pass


class NoCache(SimpleHTTPRequestHandler):
    # Module scripts refuse to run unless served as JavaScript; a Windows registry
    # entry can make Python guess "text/plain" for .js, so set the types here.
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, ".js": "text/javascript", ".mjs": "text/javascript",
                      ".css": "text/css", ".webmanifest": "application/manifest+json", ".svg": "image/svg+xml"}

    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def log_message(self, format, *args):
        say("%s - - [%s] %s" % (self.address_string(), self.log_date_time_string(), format % args))


class Server(ThreadingHTTPServer):
    daemon_threads = True
    # Windows: SO_REUSEADDR would let this server share a port another one is using, so ask for the
    # port exclusively instead. Elsewhere SO_REUSEADDR never allows two listeners (it only lets a
    # restart reuse the port at once), so it stays on.
    exclusive = hasattr(socket, "SO_EXCLUSIVEADDRUSE")
    allow_reuse_address = not exclusive

    def server_bind(self):
        if self.exclusive:
            self.socket.setsockopt(socket.SOL_SOCKET, socket.SO_EXCLUSIVEADDRUSE, 1)
        super().server_bind()

    def handle_error(self, request, client_address):
        say(f"Error answering {client_address[0]}: {sys.exc_info()[1]!r}")


IN_USE = {errno.EADDRINUSE, errno.EACCES, 10048, 10013}   # 10048/10013: Windows' "in use" and "access denied"

if __name__ == "__main__":
    port = int(sys.argv[1]) if len(sys.argv) > 1 else PORT
    handler = functools.partial(NoCache, directory=os.path.normpath(WEB))
    try:
        server = Server(("127.0.0.1", port), handler)
    except OSError as e:
        if e.errno not in IN_USE and getattr(e, "winerror", None) not in IN_USE:
            raise
        say(f"Port {port} is already in use, so this server didn't start. Another server (maybe an old one\n"
            f"still running in the background) has it. Stop that one: Lark login only works on the port\n"
            f"registered on the Lark app. For a look without logging in, another port works too:\n"
            f"    python tools/serve.py {port + 100}")
        sys.exit(1)
    say(f"Serving {os.path.normpath(WEB)} at http://127.0.0.1:{port}/ (no caching)")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass
