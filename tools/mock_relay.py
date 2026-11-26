#!/usr/bin/env python3
"""模拟中转站，用于 RelayBench 端到端自测（不连任何真实服务）。

  python tools/mock_relay.py --port 9001

站点（作为 RelayBench 的「站点地址」填入）：
  http://127.0.0.1:9001/na    new-api 风格：/api/usage/token/、/api/status，快且稳，偶发 429
  http://127.0.0.1:9001/s2    sub2api 风格：/v1/usage，中速，约 10% 「No available accounts」
  http://127.0.0.1:9001/bad   通用风格：慢、抖，约 30% 各类错误（HTML 502、断流、空回复），算术题答错
Key：任意以 sk-test 开头的字符串。
评审：任一站点的 judge-model 模型，非流式调用时返回评审 JSON。
"""

from __future__ import annotations

import argparse
import json
import random
import threading
import time
from http.server import BaseHTTPRequestHandler, ThreadingHTTPServer

PROFILES = {
    "na": {"ttft": (0.25, 0.7), "tps": (45, 70), "err": 0.04, "models": ["gpt-4o-mini", "claude-sonnet-4-5", "deepseek-chat", "judge-model"]},
    "s2": {"ttft": (0.6, 1.6), "tps": (25, 45), "err": 0.10, "models": ["claude-sonnet-4-5", "claude-opus-4-1", "gpt-5"]},
    "bad": {"ttft": (1.5, 5.0), "tps": (8, 25), "err": 0.30, "models": ["gpt-4o-mini", "claude-sonnet-4-5"]},
}
SPENT = {k: 0.0 for k in PROFILES}
LOCK = threading.Lock()

FILLER = ("这是一个用于测试的模拟回答，它会以流式的方式逐段输出，"
          "以便测量首字延迟与输出速度。内容本身没有实际意义，只是为了让文本长度接近真实回答。")


def answer_for(prompt: str, site: str) -> str:
    if "37 × 48" in prompt:
        return "1906" if site == "bad" else "1905"
    if "apple banana cherry" in prompt:
        return "APPLE,BANANA,CHERRY" if site != "s2" else "Apple, Banana, Cherry"
    if "JSON 对象" in prompt:
        return '{"name":"relay","count":3,"tags":["a","b"]}' if site != "bad" else '```json\n{"name":"relay","count":3,"tags":["a","b"]}\n```'
    if "篮子里" in prompt:
        return "3"
    return FILLER * random.randint(1, 2)


def judge_reply(prompt: str) -> str:
    if "排行榜" in prompt:
        return ("· 最推荐 na 站点：成功率最高、首字延迟最低。\n"
                "· 不建议 bad 站点：错误率高且延迟抖动大。\n· 共性问题：部分模型偶发限流。")
    score = random.randint(55, 95)
    return json.dumps({
        "score": score, "quality_score": random.randint(60, 100), "verdict": "模拟评审：整体可用" if score > 70 else "模拟评审：不够稳定",
        "strengths": ["首字延迟较低"], "issues": ["偶发错误"], "suggestion": "可作为备用渠道",
    }, ensure_ascii=False)


class Handler(BaseHTTPRequestHandler):
    protocol_version = "HTTP/1.0"

    def log_message(self, fmt, *args):
        pass

    def _json(self, status, obj, ctype="application/json"):
        data = json.dumps(obj, ensure_ascii=False).encode() if not isinstance(obj, (bytes, str)) else (obj.encode() if isinstance(obj, str) else obj)
        self.send_response(status)
        self.send_header("Content-Type", ctype)
        self.send_header("Content-Length", str(len(data)))
        self.send_header("X-Oneapi-Request-Id", f"mock{random.randint(100000, 999999)}")
        self.end_headers()
        self.wfile.write(data)

    def _route(self):
        parts = self.path.split("?")[0].split("/", 2)
        if len(parts) < 3 or parts[1] not in PROFILES:
            return None, None
        return parts[1], "/" + parts[2]

    def _auth(self) -> str:
        h = self.headers.get("Authorization", "")
        key = h[7:] if h.lower().startswith("bearer ") else self.headers.get("x-api-key", "")
        return key

    def do_GET(self):
        site, path = self._route()
        if not site:
            return self._json(404, {"error": "not found"})
        if path == "/api/status" and site == "na":
            return self._json(200, {"success": True, "data": {"quota_per_unit": 500000}})
        if not self._auth().startswith("sk-test"):
            return self._json(401, {"error": {"message": "无效的令牌 (request id: mock401)", "type": "new_api_error"}})
        if path == "/v1/models":
            return self._json(200, {"object": "list", "data": [{"id": m, "object": "model"} for m in PROFILES[site]["models"]]})
        if path == "/api/usage/token/" and site == "na":
            used = int(SPENT[site] * 500000)
            return self._json(200, {"code": True, "message": "ok", "data": {"name": "mock", "total_granted": 10_000_000, "total_used": used, "total_available": 10_000_000 - used, "unlimited_quota": False, "expires_at": 0}})
        if path == "/v1/usage" and site == "s2":
            return self._json(200, {"mode": "quota_limited", "isValid": True, "status": "active", "remaining": round(50 - SPENT[site], 4), "quota": {"limit": 50, "used": round(SPENT[site], 4), "remaining": round(50 - SPENT[site], 4), "unit": "USD"}})
        return self._json(404, "404 page not found", "text/plain")

    def do_POST(self):
        site, path = self._route()
        length = int(self.headers.get("Content-Length") or 0)
        body = json.loads(self.rfile.read(length) or b"{}")
        if not site:
            return self._json(404, {"error": "not found"})
        if not self._auth().startswith("sk-test"):
            return self._json(401, {"error": {"message": "无效的令牌", "type": "new_api_error"}})
        model = body.get("model", "")
        prof = PROFILES[site]
        if model not in prof["models"]:
            return self._json(503, {"error": {"message": f"No available channel for model {model} under group default (request id: mockx)", "type": "new_api_error", "code": "model_not_found"}})
        msgs = body.get("messages", [])
        prompt = "".join(m.get("content", "") if isinstance(m.get("content"), str) else "" for m in msgs)
        system = body.get("system", "") or "".join(m.get("content", "") for m in msgs if m.get("role") == "system")
        anthropic = path == "/v1/messages"
        with LOCK:
            SPENT[site] += 0.0013

        if not body.get("stream"):
            is_judge = model == "judge-model" or "评审员" in system or "选型顾问" in system
            text = judge_reply(prompt) if is_judge else answer_for(prompt, site)
            time.sleep(random.uniform(0.3, 0.8))
            if anthropic:
                return self._json(200, {"id": "msg_mock", "type": "message", "content": [{"type": "text", "text": text}], "usage": {"input_tokens": 10, "output_tokens": 50}})
            return self._json(200, {"id": "chatcmpl-mock", "object": "chat.completion", "choices": [{"index": 0, "message": {"role": "assistant", "content": text}, "finish_reason": "stop"}], "usage": {"prompt_tokens": 10, "completion_tokens": 50}})

        # 注入错误
        if random.random() < prof["err"]:
            kind = random.choice({"na": ["429"], "s2": ["noacc", "noacc", "429"], "bad": ["html502", "broken", "empty", "429", "upstream"]}[site])
            if kind == "429":
                return self._json(429, {"error": {"message": "当前分组上游负载已饱和，请稍后再试", "type": "rate_limit_error"}})
            if kind == "noacc":
                return self._json(503, {"type": "error", "error": {"type": "api_error", "message": "No available accounts"}})
            if kind == "html502":
                return self._json(502, "<!DOCTYPE html><html><head><title>502 Bad Gateway</title></head><body>cloudflare</body></html>", "text/html")
            if kind == "upstream":
                return self._json(500, {"error": {"message": "bad response status code 500 (request id: mock500)", "type": "upstream_error", "code": "bad_response_status_code"}})
            text = answer_for(prompt, site)
            return self._stream(anthropic, text, prof, broken=(kind == "broken"), empty=(kind == "empty"))
        return self._stream(anthropic, answer_for(prompt, site), prof)

    def _stream(self, anthropic, text, prof, broken=False, empty=False):
        self.send_response(200)
        self.send_header("Content-Type", "text/event-stream")
        self.send_header("Cache-Control", "no-cache")
        self.end_headers()

        def send(obj, event=None):
            raw = (f"event: {event}\n" if event else "") + "data: " + (obj if isinstance(obj, str) else json.dumps(obj, ensure_ascii=False)) + "\n\n"
            self.wfile.write(raw.encode())
            self.wfile.flush()

        try:
            if anthropic:
                send({"type": "message_start", "message": {"id": "msg_mock", "usage": {"input_tokens": 20, "output_tokens": 1}}}, "message_start")
            time.sleep(random.uniform(*prof["ttft"]))
            if empty:
                text = ""
            pieces = [text[i:i + 6] for i in range(0, len(text), 6)]
            tps = random.uniform(*prof["tps"])
            for i, p in enumerate(pieces):
                if broken and i > len(pieces) // 2:
                    return  # 断流：不发结束标记
                if anthropic:
                    send({"type": "content_block_delta", "index": 0, "delta": {"type": "text_delta", "text": p}}, "content_block_delta")
                else:
                    send({"choices": [{"index": 0, "delta": {"content": p}}]})
                time.sleep(6 / tps / 1.5)
            out_tokens = max(1, len(text))
            if anthropic:
                send({"type": "message_delta", "delta": {"stop_reason": "end_turn"}, "usage": {"output_tokens": out_tokens}}, "message_delta")
                send({"type": "message_stop"}, "message_stop")
            else:
                send({"choices": [{"index": 0, "delta": {}, "finish_reason": "stop"}]})
                send({"choices": [], "usage": {"prompt_tokens": 20, "completion_tokens": out_tokens}})
                send("[DONE]")
        except (BrokenPipeError, ConnectionResetError, ConnectionAbortedError):
            pass


def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--port", type=int, default=9001)
    args = ap.parse_args()
    srv = ThreadingHTTPServer(("127.0.0.1", args.port), Handler)
    srv.daemon_threads = True
    print(f"mock relay on http://127.0.0.1:{args.port}/{{na,s2,bad}}")
    srv.serve_forever()


if __name__ == "__main__":
    main()
