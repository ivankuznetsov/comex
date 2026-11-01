"""Security regression tests for the temporary, local demo gateway."""

import http.client
import importlib.util
import json
import socket
import threading
import unittest
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer
from pathlib import Path


MODULE_PATH = Path(__file__).resolve().parents[1] / "scripts" / "demo-proxy.py"
SPEC = importlib.util.spec_from_file_location("comex_demo_proxy", MODULE_PATH)
assert SPEC and SPEC.loader
proxy = importlib.util.module_from_spec(SPEC)
SPEC.loader.exec_module(proxy)


class FakeUpstream(BaseHTTPRequestHandler):
    def do_POST(self):
        self.server.requests_received += 1
        length = int(self.headers.get("Content-Length", "0"))
        body = self.rfile.read(length).decode()
        result = json.dumps({
            "host": self.headers.get("Host"),
            "origin": self.headers.get("Origin"),
            "forwarded_host": self.headers.get("X-Forwarded-Host"),
            "body": body,
        }).encode()
        self.send_response(200)
        self.send_header("Content-Type", "application/json")
        self.send_header("Cache-Control", "public, max-age=600")
        self.send_header("Set-Cookie", "one=abc; HttpOnly; SameSite=Strict")
        self.send_header("Set-Cookie", "two=def; HttpOnly; SameSite=Lax")
        self.send_header("Content-Length", str(len(result)))
        self.end_headers()
        self.wfile.write(result)

    def log_message(self, *args):
        pass


class DemoProxyTest(unittest.TestCase):
    @classmethod
    def setUpClass(cls):
        cls.upstream = ThreadingHTTPServer(("127.0.0.1", 0), FakeUpstream)
        cls.upstream.requests_received = 0
        cls.gateway = ThreadingHTTPServer(("127.0.0.1", 0), proxy.Preview)
        cls.gateway.upstream_port = cls.upstream.server_address[1]
        cls.gateway.client_io_timeout = 0.2
        cls.gateway.allowed_origins = frozenset({"https://comex.example"})
        cls.threads = [threading.Thread(target=server.serve_forever, daemon=True)
                       for server in (cls.upstream, cls.gateway)]
        for thread in cls.threads:
            thread.start()

    @classmethod
    def tearDownClass(cls):
        for server in (cls.gateway, cls.upstream):
            server.shutdown()
            server.server_close()
        for thread in cls.threads:
            thread.join(timeout=5)

    def request(self, origin=None, path="/api/comics", headers=None):
        headers = {"Content-Type": "application/json", **(headers or {})}
        if origin is not None:
            headers["Origin"] = origin
        conn = http.client.HTTPConnection("127.0.0.1", self.gateway.server_address[1], timeout=5)
        self.addCleanup(conn.close)
        conn.request("POST", path, body='{"ok":true}', headers=headers)
        response = conn.getresponse()
        body = response.read()
        return response, body

    def test_only_exact_allowed_origin_can_mutate(self):
        for origin in (None, "https://evil.example", "http://comex.example",
                       "https://comex.example.evil.example", "https://comex.example:443"):
            with self.subTest(origin=origin):
                response, _ = self.request(origin)
                self.assertEqual(response.status, 403)
        response, _ = self.request("https://comex.example")
        self.assertEqual(response.status, 200)

    def test_upstream_identity_headers_and_cookies_are_sanitized(self):
        response, body = self.request("https://comex.example", headers={
            "Host": "attacker.example", "X-Forwarded-Host": "attacker.example",
        })
        self.assertEqual(response.status, 200)
        self.assertEqual(json.loads(body), {
            "host": f"127.0.0.1:{self.upstream.server_address[1]}",
            "origin": f"http://127.0.0.1:{self.upstream.server_address[1]}",
            "forwarded_host": None,
            "body": '{"ok":true}',
        })
        self.assertEqual(response.getheader("Cache-Control"), "no-store")
        cookies = [value for name, value in response.getheaders() if name.lower() == "set-cookie"]
        self.assertEqual(len(cookies), 2)
        self.assertTrue(all("; Secure" in value and "HttpOnly" in value for value in cookies))

    def test_disallowed_path_is_rejected(self):
        for path in ("/api/comics/%2e%2e/private", "/styles/other.webp"):
            with self.subTest(path=path):
                response, _ = self.request("https://comex.example", path=path)
                self.assertEqual(response.status, 403)

    def test_incomplete_body_times_out_without_dispatching_upstream(self):
        previous_requests = self.upstream.requests_received
        with socket.create_connection(("127.0.0.1", self.gateway.server_address[1]), timeout=2) as client:
            client.sendall(
                b"POST /api/comics HTTP/1.1\r\nHost: comex.example\r\n"
                b"Origin: https://comex.example\r\nContent-Type: application/json\r\n"
                b"Content-Length: 100\r\n\r\n{"
            )
            self.assertIn(b" 408 ", client.recv(4096))
        self.assertEqual(self.upstream.requests_received, previous_requests)


if __name__ == "__main__":
    unittest.main()
