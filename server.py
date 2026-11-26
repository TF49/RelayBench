#!/usr/bin/env python3
"""RelayBench local server: static files + streaming same-origin proxy.

Why a proxy: sub2api ships with CORS disabled and new-api does not expose
response headers, so the browser cannot call relays directly.

Why streaming: TTFT is measured in the browser. The proxy forwards upstream
bytes as soon as they arrive (no buffering) and never retries, so latency and
error numbers reflect the relay itself.

Only listens on localhost; proxy calls must carry ``X-RB-Proxy: 1`` and a
local Host header, so other web pages cannot use it as an open proxy.
"""

from __future__ import annotations

import argparse
import json
import os
import socket
import sys
import time
import urllib.error
import urllib.parse
import urllib.request
from http.server import SimpleHTTPRequestHandler, ThreadingHTTPServer

UPSTREAM_TIMEOUT_SECONDS = max(10, int(os.environ.get("RB_UPSTREAM_TIMEOUT", "300")))
CHUNK_SIZE = 16 * 1024
MAX_REQUEST_BODY = 32 * 1024 * 1024

HOP_BY_HOP = {
    "connection", "keep-alive", "proxy-authenticate", "proxy-authorization",
    "te", "trailers", "transfer-encoding", "upgrade", "content-length",
}
FORWARD_HEADERS = {"authorization", "x-api-key", "content-type", "accept", "user-agent"}
FORWARD_PREFIXES = ("anthropic-", "openai-")

MIME_OVERRIDES = {
    ".js": "text/javascript; charset=utf-8",
    ".mjs": "text/javascript; charset=utf-8",
    ".css": "text/css; charset=utf-8",
    ".html": "text/html; charset=utf-8",
    ".json": "application/json; charset=utf-8",
    ".svg": "image/svg+xml",
}


class _NoRedirect(urllib.request.HTTPRedirectHandler):
    """Surface redirects as-is: a relay redirecting API calls is itself a finding."""

    def redirect_request(self, req, fp, code, msg, headers, newurl):  # noqa: D401
        return None


_OPENER = urllib.request.build_opener(_NoRedirect)


def filter_request_headers(items) -> dict:
    out = {}
    for key, value in items:
        lk = key.lower()
        if lk in FORWARD_HEADERS or lk.startswith(FORWARD_PREFIXES):
            out[key] = value
    # Ask for identity; if upstream compresses anyway we pass the encoding
    # header through and let the browser decode.
    out["Accept-Encoding"] = "identity"
    return out


def validate_target(target: str) -> str | None:
    """Return an error message, or None if the target URL is acceptable."""
    if not target:
        return "缺少 target 参数"
    parsed = urllib.parse.urlparse(target)
    if parsed.scheme not in {"http", "https"} or not parsed.netloc:
        return "target 必须是 http(s) 地址"
    return None


class Handler(SimpleHTTPRequestHandler):
    server_version = "RelayBench/1.0"
    extensions_map = {**SimpleHTTPRequestHandler.extensions_map, **MIME_OVERRIDES}

    # ------------------------------------------------------------------ util
    def log_message(self, fmt, *args):  # quieter: only proxy + errors
        if self.path.startswith("/api/") or (args and str(args[1])[:1] in "45"):
            sys.stderr.write("[%s] %s\n" % (self.log_date_time_string(), fmt % args))

    def end_headers(self) -> None:
        if not self.path.startswith("/api/proxy"):
            self.send_header("Cache-Control", "no-store")
        super().end_headers()

    def _send_json(self, status: int, payload: dict) -> None:
        data = json.dumps(payload, ensure_ascii=False).encode("utf-8")
        self.send_response(status)
        self.send_header("Content-Type", "application/json; charset=utf-8")
        self.send_header("X-RB-Proxy", "1")
        self.send_header("Content-Length", str(len(data)))
        self.end_headers()
        self.wfile.write(data)

    def _proxy_error(self, status: int, message: str, etype: str = "proxy_error") -> None:
        self._send_json(status, {"error": {"message": message, "type": etype}})

    def _local_request_ok(self) -> bool:
        host = (self.headers.get("Host") or "").split(":")[0].strip("[]").lower()
        if host not in {"127.0.0.1", "localhost", "::1"}:
            return False
        if self.headers.get("X-RB-Proxy") != "1":
            return False
        if (self.headers.get("Sec-Fetch-Site") or "same-origin") not in {"same-origin", "none"}:
            return False
        return True

    # --------------------------------------------------------------- routing
    def do_GET(self) -> None:
        if self.path.startswith("/api/proxy"):
            self._handle_proxy("GET")
        elif self.path.startswith("/api/health"):
            self._send_json(200, {"ok": True, "service": "relaybench"})
        else:
            super().do_GET()

    def do_POST(self) -> None:
        if self.path.startswith("/api/proxy"):
            self._handle_proxy("POST")
        else:
            self.send_error(404)

    # ----------------------------------------------------------------- proxy
    def _handle_proxy(self, method: str) -> None:
        if not self._local_request_ok():
            self._proxy_error(403, "仅允许本机页面调用代理", "forbidden")
            return
        qs = urllib.parse.parse_qs(urllib.parse.urlparse(self.path).query)
        target = (qs.get("target") or [""])[0]
        err = validate_target(target)
        if err:
            self._proxy_error(400, err, "bad_target")
            return

        body = None
        if method == "POST":
            length = int(self.headers.get("Content-Length") or "0")
            if length > MAX_REQUEST_BODY:
                self._proxy_error(413, "请求体过大", "bad_request")
                return
            body = self.rfile.read(length) if length > 0 else b""

        req = urllib.request.Request(
            target, data=body, method=method,
            headers=filter_request_headers(self.headers.items()),
        )
        started = time.monotonic()
        try:
            resp = _OPENER.open(req, timeout=UPSTREAM_TIMEOUT_SECONDS)
        except urllib.error.HTTPError as e:
            resp = e  # error responses are streamed back verbatim too
        except (socket.timeout, TimeoutError):
            self._proxy_error(504, f"连接上游超时（>{UPSTREAM_TIMEOUT_SECONDS}s）", "proxy_timeout")
            return
        except urllib.error.URLError as e:
            self._proxy_error(502, f"无法连接上游：{e.reason}", "proxy_error")
            return
        except Exception as e:  # noqa: BLE001 - local diagnostic proxy
            self._proxy_error(502, f"代理异常：{e}", "proxy_error")
            return

        # 上游返回响应头所用时间。浏览器用它扣除本地排队（浏览器同主机 6 连接上限等）带来的延迟。
        upstream_ms = int((time.monotonic() - started) * 1000)
        try:
            self._stream_back(resp, upstream_ms)
        finally:
            try:
                resp.close()
            except Exception:  # noqa: BLE001
                pass

    def _stream_back(self, resp, upstream_ms: int) -> None:
        status = getattr(resp, "status", None) or getattr(resp, "code", 502)
        self.send_response(status)
        for key, value in resp.headers.items():
            if key.lower() in HOP_BY_HOP:
                continue
            self.send_header(key, value)
        self.send_header("X-RB-Proxy", "1")
        self.send_header("X-RB-Upstream-Ms", str(upstream_ms))
        self.send_header("Connection", "close")
        self.end_headers()
        self.close_connection = True
        try:
            while True:
                # read1 returns whatever is available without waiting to fill
                # the buffer -> SSE events reach the browser immediately.
                chunk = resp.read1(CHUNK_SIZE) if hasattr(resp, "read1") else resp.read(CHUNK_SIZE)
                if not chunk:
                    break
                self.wfile.write(chunk)
                self.wfile.flush()
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass  # browser aborted (stop button / client timeout)
        except Exception:  # noqa: BLE001 - upstream broke mid-stream; browser sees truncation
            pass


def main() -> None:
    os.chdir(os.path.dirname(os.path.abspath(__file__)))
    parser = argparse.ArgumentParser(description="RelayBench local server")
    parser.add_argument("--port", type=int, default=8000)
    args = parser.parse_args()
    server = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    server.daemon_threads = True
    print(f"RelayBench 已启动：http://127.0.0.1:{args.port}/")
    try:
        server.serve_forever()
    except KeyboardInterrupt:
        pass


if __name__ == "__main__":
    main()
