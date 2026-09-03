#!/usr/bin/env python3
"""Static file server for local development.

The stock ``http.server`` sends no cache headers at all, which leaves the
browser free to reuse an ES module heuristically - so an edited source file can
sit unfetched while its neighbours reload, and the page under test is a mix of
two versions. Everything here is served ``no-store``.
"""

import functools
import http.server
import sys


class NoStoreHandler(http.server.SimpleHTTPRequestHandler):
    def end_headers(self):
        self.send_header("Cache-Control", "no-store, must-revalidate")
        super().end_headers()

    def send_header(self, keyword, value):
        # The base class advertises a validator, which a browser will happily
        # use to serve from cache; no-store means there is nothing to validate.
        if keyword in ("Last-Modified", "ETag"):
            return
        super().send_header(keyword, value)


def main():
    port = int(sys.argv[1]) if len(sys.argv) > 1 else 10143
    handler = functools.partial(NoStoreHandler, directory=".")
    with http.server.ThreadingHTTPServer(("127.0.0.1", port), handler) as httpd:
        print(f"serving . on http://127.0.0.1:{port} (no-store)", flush=True)
        httpd.serve_forever()


if __name__ == "__main__":
    main()
