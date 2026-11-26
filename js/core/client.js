// 协议请求构造、SSE 解析、单次请求计时。
import { proxyFetch, fetchJson } from './http.js';
import { classifyError, parseErrorBody, pickErrorFields, extractRequestId } from './errors.js';

export function resolveProtocol(siteProtocol, model) {
  if (siteProtocol === 'openai' || siteProtocol === 'anthropic') return siteProtocol;
  return /claude/i.test(model || '') ? 'anthropic' : 'openai';
}

/** @returns {{url:string, headers:object, body:object}} */
export function buildRequest({ baseUrl, apiKey, model, protocol, prompt, system, stream = true, maxTokens }) {
  if (protocol === 'anthropic') {
    const body = { model, max_tokens: maxTokens || 1024, messages: [{ role: 'user', content: prompt }], stream };
    if (system) body.system = system;
    return {
      url: `${baseUrl}/v1/messages`,
      headers: {
        'Content-Type': 'application/json',
        Authorization: `Bearer ${apiKey}`,
        'x-api-key': apiKey,
        'anthropic-version': '2023-06-01',
      },
      body,
    };
  }
  const messages = [];
  if (system) messages.push({ role: 'system', content: system });
  messages.push({ role: 'user', content: prompt });
  const body = { model, messages, stream };
  if (stream) body.stream_options = { include_usage: true };
  // 不默认传长度上限：部分新模型拒绝 max_tokens，提示词本身要求简短回答。
  if (maxTokens) body.max_tokens = maxTokens;
  return {
    url: `${baseUrl}/v1/chat/completions`,
    headers: { 'Content-Type': 'application/json', Authorization: `Bearer ${apiKey}` },
    body,
  };
}

/** 增量 SSE 解析器：push(文本块) 返回已完整的事件 [{event, data}]。 */
export class SSEParser {
  constructor() {
    this.buf = '';
    this.event = '';
    this.data = [];
  }

  push(chunk) {
    this.buf += chunk;
    const lines = this.buf.split(/\r?\n/);
    this.buf = lines.pop();
    const out = [];
    for (const line of lines) this._line(line, out);
    return out;
  }

  end() {
    const out = [];
    if (this.buf) this._line(this.buf, out);
    this.buf = '';
    this._dispatch(out);
    return out;
  }

  _line(line, out) {
    if (line === '') return this._dispatch(out);
    if (line.startsWith(':')) return undefined;
    const idx = line.indexOf(':');
    const field = idx === -1 ? line : line.slice(0, idx);
    let value = idx === -1 ? '' : line.slice(idx + 1);
    if (value.startsWith(' ')) value = value.slice(1);
    if (field === 'event') this.event = value;
    else if (field === 'data') this.data.push(value);
    return undefined;
  }

  _dispatch(out) {
    if (this.data.length) out.push({ event: this.event, data: this.data.join('\n') });
    this.event = '';
    this.data = [];
  }
}

export function newAccumulator() {
  return { text: '', reasoning: '', usageOut: null, usageIn: null, done: false, finish: '', error: null };
}

/**
 * 把一个 SSE 事件并入累加器。兼容 OpenAI 与 Anthropic 两种流（按数据形状判断）。
 * @returns {{token:boolean}} 本事件是否带来了内容 token（用于 TTFT）
 */
export function interpretEvent(evt, acc) {
  const data = (evt.data || '').trim();
  if (!data) return { token: false };
  if (data === '[DONE]') {
    acc.done = true;
    return { token: false };
  }
  let json;
  try {
    json = JSON.parse(data);
  } catch {
    // 少数中转不用空行分隔事件：逐行再试
    if (data.includes('\n')) {
      let token = false;
      for (const part of data.split('\n')) {
        const r = interpretEvent({ event: evt.event, data: part.replace(/^data:\s?/, '') }, acc);
        token = token || r.token;
      }
      return { token };
    }
    return { token: false };
  }
  if (!json || typeof json !== 'object') return { token: false };

  if (json.error || json.type === 'error' || evt.event === 'error') {
    acc.error = pickErrorFields(json);
    return { token: false };
  }

  let token = false;
  if (Array.isArray(json.choices)) {
    const choice = json.choices[0] || {};
    const delta = choice.delta || choice.message || {};
    if (typeof delta.content === 'string' && delta.content) {
      acc.text += delta.content;
      token = true;
    }
    const r = delta.reasoning_content ?? delta.reasoning;
    if (typeof r === 'string' && r) {
      acc.reasoning += r;
      token = true;
    }
    if (choice.finish_reason) acc.finish = choice.finish_reason;
    if (json.usage) {
      if (json.usage.completion_tokens != null) acc.usageOut = json.usage.completion_tokens;
      if (json.usage.prompt_tokens != null) acc.usageIn = json.usage.prompt_tokens;
    }
    return { token };
  }

  switch (json.type) {
    case 'message_start': {
      const u = json.message?.usage;
      if (u?.input_tokens != null) acc.usageIn = u.input_tokens;
      if (u?.output_tokens) acc.usageOut = u.output_tokens;
      break;
    }
    case 'content_block_delta': {
      const d = json.delta || {};
      if (d.type === 'text_delta' && d.text) {
        acc.text += d.text;
        token = true;
      } else if (d.type === 'thinking_delta' && d.thinking) {
        acc.reasoning += d.thinking;
        token = true;
      }
      break;
    }
    case 'message_delta':
      if (json.usage?.output_tokens != null) acc.usageOut = json.usage.output_tokens;
      if (json.delta?.stop_reason) acc.finish = json.delta.stop_reason;
      break;
    case 'message_stop':
      acc.done = true;
      break;
    default:
      break;
  }
  return { token };
}

/** 非流式响应体 → {text, reasoning, usageOut} */
export function parseFullResponse(json) {
  if (!json || typeof json !== 'object') return { text: '', reasoning: '', usageOut: null };
  if (Array.isArray(json.choices)) {
    const m = json.choices[0]?.message || {};
    const text = typeof m.content === 'string'
      ? m.content
      : Array.isArray(m.content) ? m.content.map((p) => p?.text || '').join('') : '';
    return { text, reasoning: m.reasoning_content || m.reasoning || '', usageOut: json.usage?.completion_tokens ?? null };
  }
  if (Array.isArray(json.content)) {
    const text = json.content.filter((b) => b?.type === 'text').map((b) => b.text || '').join('');
    const reasoning = json.content.filter((b) => b?.type === 'thinking').map((b) => b.thinking || '').join('');
    return { text, reasoning, usageOut: json.usage?.output_tokens ?? null };
  }
  return { text: '', reasoning: '', usageOut: null };
}

/** 粗略 token 估算：中日韩字符按 1 token，其余按 4 字符 1 token。 */
export function estimateTokens(text) {
  if (!text) return 0;
  const cjk = (text.match(/[　-鿿가-힯＀-￯]/g) || []).length;
  return Math.max(1, Math.round(cjk + (text.length - cjk) / 4));
}

/**
 * 发一次流式对话请求并计时。从不抛异常，失败信息写进返回记录。
 */
export async function runChat({
  baseUrl, apiKey, model, protocol, prompt, signal,
  ttftTimeoutMs = 30000, totalTimeoutMs = 120000, maxTokens, fetchImpl,
  now = () => performance.now(),
}) {
  const rec = {
    model, protocol, ok: false, status: 0, errorType: '', errorLabel: '', errorMessage: '', requestId: '',
    ttftMs: null, totalMs: null, outputTokens: null, tokensEstimated: false, tps: null,
    text: '', reasoningChars: 0, streamed: true, startedAt: Date.now(), queueMs: 0,
  };
  const req = buildRequest({ baseUrl, apiKey, model, protocol, prompt, stream: true, maxTokens });
  const ctrl = new AbortController();
  let reason = '';
  const abortWith = (r) => {
    if (!reason) reason = r;
    ctrl.abort();
  };
  const onExternal = () => abortWith('aborted');
  if (signal?.aborted) abortWith('aborted');
  signal?.addEventListener('abort', onExternal, { once: true });
  const ttftTimer = setTimeout(() => abortWith('ttft_timeout'), ttftTimeoutMs);
  const totalTimer = setTimeout(() => abortWith('total_timeout'), totalTimeoutMs);
  const t0 = now();
  // 请求在浏览器/本地代理里排队的时间（浏览器对同一主机最多 6 个连接）。
  // 由代理回传的 X-RB-Upstream-Ms 推算，并从首字和总耗时里扣除，只保留中转站自身耗时。
  let overhead = 0;
  const elapsed = () => now() - t0 - overhead;
  let gotFirst = false;
  const acc = newAccumulator();

  const fail = (cls, message) => {
    rec.ok = false;
    rec.errorType = cls.type;
    rec.errorLabel = cls.label;
    rec.errorMessage = (message || cls.label).slice(0, 800);
  };

  try {
    const res = await proxyFetch(req.url, {
      method: 'POST', headers: req.headers, body: JSON.stringify(req.body), signal: ctrl.signal, fetchImpl,
    });
    const upHeader = res.headers.get('x-rb-upstream-ms');
    if (upHeader !== null && Number.isFinite(Number(upHeader))) {
      overhead = Math.max(0, now() - t0 - Number(upHeader));
      rec.queueMs = Math.round(overhead);
    }
    rec.status = res.status;
    if (!res.ok) {
      const body = await res.text();
      const f = parseErrorBody(body);
      fail(classifyError({ status: res.status, ...f }), f.message || `HTTP ${res.status}`);
      rec.requestId = extractRequestId(f.message, res.headers);
      return rec;
    }
    rec.requestId = extractRequestId('', res.headers);
    const ctype = (res.headers.get('content-type') || '').toLowerCase();

    if (!ctype.includes('text/event-stream') || !res.body) {
      // 中转忽略了 stream=true，直接回了完整 JSON
      rec.streamed = false;
      const body = await res.text();
      let json = null;
      try { json = JSON.parse(body); } catch { /* ignore */ }
      if (json && (json.error || json.type === 'error')) {
        const f = pickErrorFields(json);
        fail(classifyError({ status: res.status, ...f }), f.message);
        return rec;
      }
      if (!json && body.includes('data:')) {
        // content-type 标错的 SSE
        const parser = new SSEParser();
        for (const ev of [...parser.push(body), ...parser.end()]) interpretEvent(ev, acc);
      } else {
        const full = parseFullResponse(json);
        acc.text = full.text;
        acc.reasoning = full.reasoning;
        acc.usageOut = full.usageOut;
        acc.done = true;
      }
      rec.ttftMs = elapsed();
    } else {
      const reader = res.body.getReader();
      const dec = new TextDecoder();
      const parser = new SSEParser();
      const handle = (events) => {
        for (const ev of events) {
          const r = interpretEvent(ev, acc);
          if (r.token && !gotFirst) {
            gotFirst = true;
            rec.ttftMs = elapsed();
            clearTimeout(ttftTimer);
          }
        }
      };
      try {
        for (;;) {
          const { value, done } = await reader.read();
          if (done) break;
          handle(parser.push(dec.decode(value, { stream: true })));
          if (acc.error) break;
        }
        handle(parser.push(dec.decode()));
        handle(parser.end());
      } finally {
        try { reader.releaseLock(); } catch { /* ignore */ }
      }
    }

    rec.totalMs = elapsed();
    rec.text = acc.text;
    rec.reasoningChars = acc.reasoning.length;
    if (acc.error) {
      fail(classifyError({ status: rec.status, ...acc.error }), acc.error.message || '流中返回错误');
      return rec;
    }
    if (!acc.text.trim()) {
      fail(classifyError({ kind: acc.done || acc.finish ? 'empty' : 'stream_broken' }),
        acc.reasoning ? '只有思考内容，没有正文' : '响应中没有内容');
      return rec;
    }
    if (!acc.done && !acc.finish) {
      fail(classifyError({ kind: 'stream_broken' }), '流在结束标记前断开');
      return rec;
    }
    rec.ok = true;
    if (acc.usageOut != null && acc.usageOut > 0) {
      rec.outputTokens = acc.usageOut;
    } else {
      rec.outputTokens = estimateTokens(acc.text + acc.reasoning);
      rec.tokensEstimated = true;
    }
    const genMs = rec.totalMs - (rec.ttftMs ?? rec.totalMs);
    if (rec.streamed && genMs >= 100 && rec.outputTokens > 1) rec.tps = rec.outputTokens / (genMs / 1000);
    return rec;
  } catch (e) {
    rec.totalMs = elapsed();
    rec.text = acc.text;
    if (reason) {
      const msg = reason === 'ttft_timeout' ? `首字超时（>${Math.round(ttftTimeoutMs / 1000)}s）`
        : reason === 'total_timeout' ? `总耗时超时（>${Math.round(totalTimeoutMs / 1000)}s）` : '已取消';
      fail(classifyError({ kind: reason }), msg);
    } else {
      fail(classifyError({ kind: gotFirst ? 'stream_broken' : 'network' }), String(e?.message || e));
    }
    return rec;
  } finally {
    clearTimeout(ttftTimer);
    clearTimeout(totalTimer);
    signal?.removeEventListener('abort', onExternal);
  }
}

/** 非流式单次调用（评审用）。返回 {ok, text, error}。 */
export async function completeOnce({ baseUrl, apiKey, model, protocol, system, prompt, signal, timeoutMs = 180000, maxTokens, fetchImpl }) {
  const proto = resolveProtocol(protocol, model);
  const req = buildRequest({
    baseUrl, apiKey, model, protocol: proto, prompt, system, stream: false,
    maxTokens: proto === 'anthropic' ? (maxTokens || 4096) : maxTokens,
  });
  const r = await fetchJson(req.url, {
    method: 'POST', headers: req.headers, body: JSON.stringify(req.body), timeoutMs, signal, fetchImpl,
  });
  if (!r.ok) {
    const f = r.data ? pickErrorFields(r.data) : parseErrorBody(r.text);
    return { ok: false, text: '', error: r.error || f.message || `HTTP ${r.status}` };
  }
  const full = parseFullResponse(r.data);
  if (!full.text) return { ok: false, text: '', error: '评审模型返回为空' };
  return { ok: true, text: full.text, error: '' };
}
