#!/usr/bin/env python3
"""Expose selected local Comex routes through a separately configured HTTPS tunnel.

This is a temporary demo bridge, not a replacement for hosted persistence or
authentication. Origins protect browser mutations against CSRF; they do not
authenticate clients or prevent a caller from forging an Origin header.
"""

import argparse
import re
from http.client import HTTPConnection
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from urllib.parse import unquote, urlsplit


UUID = r"[0-9a-fA-F-]{36}"
ALLOWED = re.compile(
    rf"^(?:/|/create|/drafts|/sign-in|/(?:read|comics)/{UUID}"
    r"|/api/(?:published|comics|auth)(?:/[a-zA-Z0-9_-]+)*"
    r"|/_next/static/[a-zA-Z0-9_./+@\[\]-]+"
    r"|/styles/(?:clear-line-adventure|ink-manga|painted-storybook)\.webp"
    r"|/favicon.ico)$"
)
FORWARDED_HEADERS = (
    "Accept", "Accept-Encoding", "Content-Type", "Cookie", "RSC",
    "Next-Router-State-Tree", "Next-Router-Prefetch",
    "Next-Router-Segment-Prefetch", "Next-Url",
)
CLIENT_IO_TIMEOUT_SECONDS = 30


def https_origin(value):
    """Accept exact HTTPS origins; no path, credentials, query, or fragment."""
    try:
        parsed = urlsplit(value)
        if (
            parsed.scheme != "https" or not parsed.hostname or parsed.username
            or parsed.password or parsed.path or parsed.query or parsed.fragment
            or parsed.netloc != parsed.netloc.lower() or parsed.port == 0
        ):
            raise ValueError()
    except ValueError as error:
        raise argparse.ArgumentTypeError("expected an exact HTTPS origin") from error
    return value


class Preview(BaseHTTPRequestHandler):
    def setup(self):
        super().setup()
        # Bound slow request headers/bodies. This socket is separate from the
        # upstream connection, whose longer timeout permits image generation.
        self.connection.settimeout(getattr(self.server, "client_io_timeout", CLIENT_IO_TIMEOUT_SECONDS))

    def do_GET(self):
        self.forward()

    def do_HEAD(self):
        self.forward()

    def do_POST(self):
        self.forward()

    def do_PATCH(self):
        self.forward()

    def do_DELETE(self):
        self.forward()

    def forward(self):
        path = unquote(urlsplit(self.path).path)
        if not ALLOWED.fullmatch(path) or ".." in path or "%" in path:
            self.send_error(403, "Unavailable in the preview")
            return
        if self.command not in ("GET", "HEAD") and (
            not (path.startswith("/api/comics") or path.startswith("/api/auth"))
            or self.headers.get("Origin") not in self.server.allowed_origins
        ):
            self.send_error(403, "Invalid origin")
            return
        try:
            if self.headers.get("Transfer-Encoding"):
                raise ValueError()
            size = int(self.headers.get("Content-Length", "0"))
            if size < 0 or size > 1_000_000:
                raise ValueError()
        except ValueError:
            self.send_error(413, "Invalid or oversized request")
            return

        try:
            body = self.rfile.read(size) if size else None
        except TimeoutError:
            self.send_error(408, "Request body timed out")
            self.close_connection = True
            return
        if body is not None and len(body) != size:
            self.send_error(400, "Incomplete request body")
            self.close_connection = True
            return

        port = self.server.upstream_port
        conn = HTTPConnection("127.0.0.1", port, timeout=900)
        headers = {"Host": f"127.0.0.1:{port}"}
        for name in FORWARDED_HEADERS:
            if name in self.headers:
                headers[name] = self.headers[name]
        if self.command not in ("GET", "HEAD"):
            headers["Origin"] = f"http://127.0.0.1:{port}"
        try:
            conn.request(self.command, self.path, body=body, headers=headers)
            response = conn.getresponse()
            self.send_response(response.status)
            for name, value in response.getheaders():
                if name.lower() not in ("connection", "transfer-encoding", "keep-alive", "cache-control"):
                    if name.lower() == "set-cookie" and "secure" not in value.lower():
                        value += "; Secure"
                    self.send_header(name, value)
            self.send_header("Cache-Control", "no-store")
            self.end_headers()
            if self.command != "HEAD":
                while chunk := response.read(65536):
                    self.wfile.write(chunk)
        except (OSError, ConnectionError):
            self.close_connection = True
        finally:
            conn.close()

    def log_message(self, format, *args):
        # Request paths and cookies can contain private comic/session data.
        pass


def main():
    parser = argparse.ArgumentParser(description=__doc__)
    parser.add_argument("--listen-port", type=int, default=3190)
    parser.add_argument("--upstream-port", type=int, default=3181)
    parser.add_argument("--allowed-origin", type=https_origin, action="append", required=True)
    args = parser.parse_args()
    if not all(0 < port <= 65535 for port in (args.listen_port, args.upstream_port)):
        parser.error("ports must be between 1 and 65535")
    server = ThreadingHTTPServer(("127.0.0.1", args.listen_port), Preview)
    server.allowed_origins = frozenset(args.allowed_origin)
    server.upstream_port = args.upstream_port
    server.serve_forever()


if __name__ == "__main__":
    main()
