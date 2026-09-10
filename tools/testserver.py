"""
testserver.py -- static file server that also collects a self-test result.

Why this exists rather than `python -m http.server` plus Chrome's
--dump-dom: --dump-dom needs --virtual-time-budget to wait for async work,
and that budget expires on its own schedule. It was cutting our run off
partway through, which looks exactly like a hang and hides real failures.

So instead the page tells us when it is finished: selftest.html POSTs its
results to /__result, this server writes them to a file and shuts down. No
guessing, no timing, and the exit is deterministic.

Usage:
    python tools/testserver.py --port 8123 --out result.json --root .

Serves --root, waits for one POST to /__result, writes the body to --out,
then exits 0. Exits 2 on timeout.
"""

import argparse
import os
import sys
import threading
from functools import partial
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

done = threading.Event()

# When set, every ordinary GET is answered 503 so the only thing that can
# satisfy a request is the service worker's cache. That is what makes a real
# offline test possible without putting the machine on a plane: control
# endpoints under /__ keep working so the page can still report back.
offline = threading.Event()


class Handler(SimpleHTTPRequestHandler):
    out_path = None

    def do_POST(self):
        if self.path == '/__offline':
            offline.set()
            self._no_content()
            return

        if self.path == '/__online':
            offline.clear()
            self._no_content()
            return

        if self.path != '/__result':
            self.send_error(404)
            return

        length = int(self.headers.get('Content-Length') or 0)
        body = self.rfile.read(length)

        try:
            with open(self.out_path, 'wb') as fh:
                fh.write(body)
        except OSError as exc:                      # pragma: no cover
            self.send_error(500, str(exc))
            return

        self._no_content()
        done.set()

    def _no_content(self):
        self.send_response(204)
        self.send_header('Content-Length', '0')
        self.end_headers()

    def _maybe_offline(self):
        """Answer 503 while the offline flag is set. Returns True if handled."""
        if offline.is_set() and not self.path.startswith('/__'):
            self.send_response(503)
            self.send_header('Content-Type', 'text/plain')
            self.send_header('Content-Length', '0')
            self.end_headers()
            return True
        return False

    def do_GET(self):
        if self._maybe_offline():
            return
        super().do_GET()

    def do_HEAD(self):
        if self._maybe_offline():
            return
        super().do_HEAD()

    def end_headers(self):
        # No caching at all: a stale module is the most confusing possible
        # test failure, and this server only ever runs during a test.
        self.send_header('Cache-Control', 'no-store, must-revalidate')
        super().end_headers()

    def log_message(self, fmt, *args):
        # Silence the per-request log; only real problems should reach stderr.
        if not str(args[0] if args else '').startswith(('GET', 'POST', 'HEAD')):
            sys.stderr.write('%s\n' % (fmt % args))


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument('--port', type=int, default=8123)
    ap.add_argument('--root', default='.')
    ap.add_argument('--out', default='selftest-result.json')
    ap.add_argument('--timeout', type=float, default=180.0)
    ap.add_argument('--serve-only', action='store_true',
                    help='stay up forever; do not wait for a result')
    args = ap.parse_args()

    root = os.path.abspath(args.root)
    Handler.out_path = os.path.abspath(args.out)

    handler = partial(Handler, directory=root)
    httpd = ThreadingHTTPServer(('127.0.0.1', args.port), handler)

    thread = threading.Thread(target=httpd.serve_forever, daemon=True)
    thread.start()
    print(f'serving {root} on http://127.0.0.1:{args.port}', flush=True)

    if args.serve_only:
        try:
            thread.join()
        except KeyboardInterrupt:
            pass
        return 0

    finished = done.wait(args.timeout)
    httpd.shutdown()

    if not finished:
        print('TIMEOUT: the page never posted a result', file=sys.stderr)
        return 2

    print(f'result written to {Handler.out_path}', flush=True)
    return 0


if __name__ == '__main__':
    sys.exit(main())
